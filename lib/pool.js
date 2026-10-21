'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateHeaderName, validateHeaderValue } = require('http');
const { DeepSeekClient } = require('./dsweb');

class PoolError extends Error {
  constructor(message, { status = 503, code = 'pool_unavailable', retryAfterMs = 0, type = 'pool_error' } = {}) {
    super(message);
    this.name = 'PoolError';
    this.status = status;
    this.code = code;
    this.type = type;
    this.retryAfterMs = retryAfterMs;
  }
}

function invalid(message) {
  return new PoolError(message, { status: 400, code: 'invalid_account', type: 'invalid_request_error' });
}

function positive(value, fallback, label, integer = true) {
  const number = value === undefined ? fallback : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0 || (integer && !Number.isSafeInteger(number))) {
    throw invalid(`${label} 必须是正${integer ? '整数' : '数'}`);
  }
  return number;
}

function normalizeAccounts(accounts, defaults = {}) {
  if (!Array.isArray(accounts)) throw invalid('accounts 必须是数组');
  const ids = new Set();
  const tokens = new Set();
  return accounts.map((account) => {
    if (!account || typeof account !== 'object' || Array.isArray(account)) throw invalid('账号配置必须是对象');
    if (typeof account.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(account.id)) {
      throw invalid('账号 id 必须是 1–64 位英数字、点、下划线或连字符');
    }
    if (ids.has(account.id)) throw invalid(`账号 id 重复：${account.id}`);
    ids.add(account.id);
    const name = account.name === undefined ? account.id : account.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw invalid('账号名称须为 1–120 个字符');
    if (account.token !== undefined && typeof account.token !== 'string') throw invalid('token 必须是字符串');
    const token = (account.token || '').trim();
    if (token && tokens.has(token)) throw invalid('同一 Token 不能重复添加账号，否则无法保证单账号限额');
    if (token) tokens.add(token);
    if (token.length > 32768 || /[\r\n]/.test(token)) throw invalid('token 格式无效');
    if (account.enabled !== undefined && typeof account.enabled !== 'boolean') throw invalid('enabled 必须是布尔值');
    if (account.device_id !== undefined && typeof account.device_id !== 'string') throw invalid('device_id 必须是字符串');
    const cooldown = positive(account.cooldown_seconds, defaults.cooldown_seconds ?? 60, 'cooldown_seconds', false);
    const maxCooldown = positive(account.max_cooldown_seconds, defaults.max_cooldown_seconds ?? 900, 'max_cooldown_seconds', false);
    if (maxCooldown < cooldown) throw invalid('max_cooldown_seconds 不能小于 cooldown_seconds');
    if (maxCooldown > 31536000) throw invalid('冷却时间不能超过一年');
    let expires = null;
    if (account.token_expires_at !== undefined && account.token_expires_at !== null && account.token_expires_at !== '') {
      if (typeof account.token_expires_at !== 'string' || !Number.isFinite(Date.parse(account.token_expires_at))) {
        throw invalid('token_expires_at 必须是有效日期字符串或 null');
      }
      expires = new Date(account.token_expires_at).toISOString();
    }
    const headers = account.extra_headers ?? {};
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw invalid('extra_headers 必须是对象');
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string' || /[\r\n]/.test(key + value)) throw invalid('extra_headers 必须包含合法字符串请求头');
      if (key.toLowerCase() === 'authorization') throw invalid('请使用 token 字段设置账号凭证');
      try { validateHeaderName(key); validateHeaderValue(key, value); }
      catch { throw invalid('extra_headers 必须包含合法字符串请求头'); }
    }
    return {
      id: account.id, name: name.trim(), token, enabled: account.enabled !== false,
      qps: positive(account.qps, defaults.qps ?? 1, 'qps'),
      rpm: positive(account.rpm, defaults.rpm ?? 20, 'rpm'),
      max_concurrent: positive(account.max_concurrent, defaults.max_concurrent ?? 1, 'max_concurrent'),
      cooldown_seconds: cooldown, max_cooldown_seconds: maxCooldown,
      token_expires_at: expires, device_id: account.device_id || '', extra_headers: { ...headers },
    };
  });
}

class AccountPool {
  constructor({ accounts = [], defaults = {}, clientOptions = {}, clientFactory, queueTimeoutMs = 30000, maxPending = 100, now = Date.now, stateFile = null } = {}) {
    if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs < 0) throw invalid('queueTimeoutMs 必须是非负数');
    if (!Number.isInteger(maxPending) || maxPending < 0) throw invalid('maxPending 必须是非负整数');
    this.defaults = defaults;
    this.clientOptions = clientOptions;
    this.clientFactory = clientFactory || ((options) => new DeepSeekClient(options));
    this.queueTimeoutMs = queueTimeoutMs;
    this.maxPending = maxPending;
    this.now = now;
    this.records = new Map();
    this.pending = [];
    this.cursor = 0;
    this.timer = null;
    this.closed = false;
    this.stateFile = stateFile ? path.resolve(stateFile) : null;
    this.persistenceError = null;
    this.restoring = true;
    const saved = this._readState();
    this.setAccounts(accounts);
    for (const state of this.records.values()) {
      const restored = saved.get(state.config.id);
      if (restored?.fingerprint === this._fingerprint(state.config)) {
        state.invalidReason = restored.invalid_reason;
        state.cooldownUntil = restored.cooldown_until;
        state.rateFailures = restored.rate_failures;
      }
    }
    this.restoring = false;
    if (!this.persistenceError) this._persistState();
  }

  _fingerprint(config) {
    return crypto.createHash('sha256').update(JSON.stringify([config.id, config.token, config.token_expires_at])).digest('hex');
  }

  _readState() {
    if (!this.stateFile) return new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.accounts)) throw new Error('invalid schema');
      const reasons = [null, 'token_expired', 'authentication_failed', 'account_muted', 'verification_required'];
      const entries = saved.accounts.map((entry) => {
        if (!entry || typeof entry.id !== 'string' || !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
          !reasons.includes(entry.invalid_reason) || !Number.isFinite(entry.cooldown_until) || entry.cooldown_until < 0 ||
          entry.cooldown_until > 8640000000000000 || !Number.isSafeInteger(entry.rate_failures) || entry.rate_failures < 0) {
          throw new Error('invalid state');
        }
        return [entry.id, entry];
      });
      return new Map(entries);
    } catch (error) {
      if (error.code !== 'ENOENT') this.persistenceError = 'state_read_failed';
      return new Map();
    }
  }

  _persistState() {
    if (!this.stateFile || this.restoring) return;
    let temporary = null;
    try {
      const accounts = [...this.records.values()].map((state) => ({
        id: state.config.id, fingerprint: this._fingerprint(state.config), invalid_reason: state.invalidReason,
        cooldown_until: state.cooldownUntil, rate_failures: state.rateFailures,
      }));
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      temporary = `${this.stateFile}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, accounts }) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, this.stateFile);
      this.persistenceError = null;
    } catch {
      this.persistenceError = 'state_write_failed';
      if (temporary) {
        try { fs.unlinkSync(temporary); } catch { /* The atomic target was not changed. */ }
      }
    }
  }

  setAccounts(accounts) {
    if (this.closed) throw new PoolError('账号池已关闭');
    const configs = normalizeAccounts(accounts, this.defaults);
    // Construct every changed client before publishing any update.
    const plans = configs.map((config) => {
      const previous = this.records.get(config.id);
      const changed = !previous || previous.config.token !== config.token || previous.config.device_id !== config.device_id ||
        JSON.stringify(previous.config.extra_headers) !== JSON.stringify(config.extra_headers);
      let client = previous?.client;
      const deviceId = config.device_id || previous?.deviceId || crypto.randomUUID();
      if (changed) {
        const extraHeaders = { ...this.clientOptions.extraHeaders, ...config.extra_headers };
        for (const key of Object.keys(extraHeaders)) if (key.toLowerCase() === 'authorization') delete extraHeaders[key];
        client = this.clientFactory({ ...this.clientOptions, token: config.token, deviceId, extraHeaders });
      }
      return { config, previous, changed, client, deviceId };
    });
    const records = new Map();
    for (const plan of plans) {
      const { config, previous, client, deviceId } = plan;
      const state = previous || {
        generation: 0, inFlight: 0, starts: [], cooldownUntil: 0, invalidReason: null, rateFailures: 0,
        lastOutcome: null, lastFailureReason: null, lastCheckedAt: null,
        stats: { attempts: 0, success: 0, failed: 0, cancelled: 0 },
      };
      const credentialsUpdated = previous && (previous.config.token !== config.token || previous.config.token_expires_at !== config.token_expires_at);
      if (plan.changed || credentialsUpdated) state.generation++;
      if (credentialsUpdated) {
        state.invalidReason = null;
        state.cooldownUntil = 0;
        state.rateFailures = 0;
        state.lastOutcome = null;
        state.lastFailureReason = null;
        state.lastCheckedAt = null;
      }
      Object.assign(state, { config, client, deviceId });
      records.set(config.id, state);
    }
    this.records = records;
    this.cursor %= Math.max(1, records.size);
    this._persistState();
    this._drain();
  }

  _refresh(state, now) {
    while (state.starts.length && state.starts[0] <= now - 60000) state.starts.shift();
    if (state.config.token_expires_at && Date.parse(state.config.token_expires_at) <= now && state.invalidReason !== 'token_expired') {
      state.invalidReason = 'token_expired';
      this._persistState();
    }
  }

  _status(state, now) {
    this._refresh(state, now);
    if (!state.config.enabled) return 'disabled';
    if (!state.config.token) return 'missing_token';
    if (state.invalidReason) return 'invalid';
    if (state.cooldownUntil > now) return 'cooldown';
    if (state.inFlight >= state.config.max_concurrent) return 'busy';
    const seconds = state.starts.filter((start) => start > now - 1000).length;
    if (seconds >= state.config.qps || state.starts.length >= state.config.rpm) return 'rate_limited';
    return 'available';
  }

  _health(state, now) {
    this._refresh(state, now);
    let status = 'unknown';
    let reason = null;
    if (!state.config.token) {
      status = 'unhealthy';
      reason = 'missing_token';
    } else if (state.invalidReason) {
      status = 'unhealthy';
      reason = state.invalidReason;
    } else if (state.cooldownUntil > now) {
      status = 'unhealthy';
      reason = state.lastFailureReason || (state.rateFailures > 0 ? 'rate_limited' : 'upstream_error');
    } else if (state.lastOutcome === 'success') {
      status = 'healthy';
    } else if (state.lastOutcome === 'failure' || state.cooldownUntil > 0 || state.rateFailures > 0) {
      reason = 'awaiting_retry';
    }
    return {
      health_status: status, health_reason: reason,
      last_checked_at: state.lastCheckedAt === null ? null : new Date(state.lastCheckedAt).toISOString(),
    };
  }

  _schedulable(state, now, status = this._status(state, now)) {
    return !this.closed && status === 'available' && this._health(state, now).health_status !== 'unhealthy';
  }

  _eligible(exclude, now) {
    return [...this.records.values()].filter((state) => {
      const status = this._status(state, now);
      return !exclude.has(state.config.id) && !['disabled', 'missing_token', 'invalid'].includes(status);
    });
  }

  _select(exclude, now) {
    const states = [...this.records.values()];
    for (let offset = 0; offset < states.length; offset++) {
      const index = (this.cursor + offset) % states.length;
      const state = states[index];
      if (!exclude.has(state.config.id) && this._schedulable(state, now)) {
        this.cursor = (index + 1) % states.length;
        return this._lease(state, now);
      }
    }
    return null;
  }

  _lease(state, now) {
    state.inFlight++;
    state.starts.push(now);
    state.stats.attempts++;
    const generation = state.generation;
    let released = false;
    return {
      accountId: state.config.id,
      client: state.client,
      release: (error = null) => {
        if (released) return;
        released = true;
        state.inFlight--;
        const cancelled = error && (error.status === 499 || error.name === 'AbortError' || error.kind === 'cancelled');
        if (!error) state.stats.success++;
        else if (cancelled) state.stats.cancelled++;
        else state.stats.failed++;
        // A request using an old token cannot invalidate its replacement.
        if (generation === state.generation && this.records.get(state.config.id) === state) {
          if (!error) {
            const healthChanged = state.rateFailures !== 0 || (state.cooldownUntil > 0 && state.cooldownUntil <= this.now());
            state.lastOutcome = 'success';
            state.lastCheckedAt = this.now();
            state.rateFailures = 0;
            if (state.cooldownUntil <= this.now()) {
              state.cooldownUntil = 0;
              state.lastFailureReason = null;
            }
            if (healthChanged) this._persistState();
          } else if (error && !cancelled) this._recordFailure(state, error);
        }
        this._drain();
      },
    };
  }

  _recordFailure(state, error) {
    const kind = error.kind || (error.status === 401 ? 'auth' : error.status === 429 ? 'rate_limit' : 'upstream');
    state.lastOutcome = 'failure';
    state.lastCheckedAt = this.now();
    if (['auth', 'mute', 'captcha'].includes(kind)) {
      state.invalidReason = kind === 'auth' ? 'authentication_failed' : kind === 'mute' ? 'account_muted' : 'verification_required';
      state.lastFailureReason = state.invalidReason;
    } else if (kind === 'rate_limit') {
      state.lastFailureReason = 'rate_limited';
      state.rateFailures++;
      const backoff = Math.min(state.config.max_cooldown_seconds * 1000,
        state.config.cooldown_seconds * 1000 * (2 ** Math.min(30, state.rateFailures - 1)));
      const retryAfter = Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0;
      state.cooldownUntil = Math.max(state.cooldownUntil, this.now() + Math.max(backoff, retryAfter));
    } else {
      state.lastFailureReason = 'upstream_error';
      state.cooldownUntil = Math.max(state.cooldownUntil, this.now() + 2000);
    }
    this._persistState();
  }

  async acquire({ signal, exclude = [] } = {}) {
    if (this.closed) throw new PoolError('账号池已关闭');
    if (signal?.aborted) throw this._cancelError();
    const excluded = new Set(exclude);
    const now = this.now();
    if (!this._eligible(excluded, now).length) throw new PoolError('没有可用的有效账号，请检查账号状态或更新 token');
    if (!this.pending.length) {
      const lease = this._select(excluded, now);
      if (lease) return lease;
    }
    if (this.pending.length >= this.maxPending) {
      throw new PoolError('账号池等待队列已满', { status: 429, code: 'pool_queue_full', retryAfterMs: 1000 });
    }
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, signal, exclude: excluded, deadline: now + this.queueTimeoutMs, onAbort: null };
      item.onAbort = () => {
        const index = this.pending.indexOf(item);
        if (index >= 0) {
          this.pending.splice(index, 1);
          this._settle(item, this._cancelError());
          this._drain();
        }
      };
      signal?.addEventListener('abort', item.onAbort, { once: true });
      this.pending.push(item);
      // An AbortSignal can be cancelled between the initial check and registration.
      if (signal?.aborted) item.onAbort();
      else this._drain();
    });
  }

  _cancelError() {
    return new PoolError('请求已取消', { status: 499, code: 'request_cancelled', type: 'request_cancelled' });
  }

  _settle(item, error, lease) {
    item.signal?.removeEventListener('abort', item.onAbort);
    if (error) item.reject(error);
    else item.resolve(lease);
  }

  _drain() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.closed) return;
    const now = this.now();
    // Remove expired/cancelled waiters anywhere in the queue, then grant strictly FIFO.
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const item = this.pending[index];
      let error = null;
      if (item.signal?.aborted) error = this._cancelError();
      else if (item.deadline <= now) error = new PoolError('等待可用账号超时', { status: 429, code: 'pool_timeout', retryAfterMs: 1000 });
      else if (!this._eligible(item.exclude, now).length) error = new PoolError('没有可用的有效账号，请更新凭证或启用账号');
      if (error) {
        this.pending.splice(index, 1);
        this._settle(item, error);
      }
    }
    while (this.pending.length) {
      const item = this.pending[0];
      const lease = this._select(item.exclude, now);
      if (!lease) break;
      this.pending.shift();
      this._settle(item, null, lease);
    }
    if (!this.pending.length) return;
    let wakeAt = Math.min(...this.pending.map((item) => item.deadline));
    for (const state of this._eligible(this.pending[0].exclude, now)) {
      const config = state.config;
      if (state.cooldownUntil > now) wakeAt = Math.min(wakeAt, state.cooldownUntil);
      const secondStarts = state.starts.filter((start) => start > now - 1000);
      if (secondStarts.length >= config.qps) wakeAt = Math.min(wakeAt, secondStarts[secondStarts.length - config.qps] + 1000);
      if (state.starts.length >= config.rpm) wakeAt = Math.min(wakeAt, state.starts[state.starts.length - config.rpm] + 60000);
      if (config.token_expires_at) wakeAt = Math.min(wakeAt, Date.parse(config.token_expires_at));
    }
    this.timer = setTimeout(() => this._drain(), Math.max(1, Math.min(2147483647, wakeAt - now)));
  }

  snapshot() {
    const now = this.now();
    const accounts = [...this.records.values()].map((state) => {
      const status = this._status(state, now);
      const { config, stats } = state;
      return {
        id: config.id, name: config.name, enabled: config.enabled, status,
        ...this._health(state, now), schedulable: this._schedulable(state, now, status),
        token_configured: !!config.token, token_expires_at: config.token_expires_at,
        qps: config.qps, rpm: config.rpm, max_concurrent: config.max_concurrent,
        cooldown_seconds: config.cooldown_seconds, max_cooldown_seconds: config.max_cooldown_seconds,
        in_flight: state.inFlight, qps_used: state.starts.filter((start) => start > now - 1000).length,
        rpm_used: state.starts.length, cooldown_until: state.cooldownUntil > now ? new Date(state.cooldownUntil).toISOString() : null,
        invalid_reason: state.invalidReason,
        stats: { ...stats, success_rate: stats.success + stats.failed ? stats.success / (stats.success + stats.failed) : 0 },
      };
    });
    return {
      persistence_error: this.persistenceError,
      summary: {
        total: accounts.length, available: accounts.filter((account) => account.status === 'available').length,
        busy: accounts.filter((account) => account.status === 'busy').length,
        cooling_down: accounts.filter((account) => account.status === 'cooldown').length,
        invalid: accounts.filter((account) => ['invalid', 'missing_token'].includes(account.status)).length,
        disabled: accounts.filter((account) => account.status === 'disabled').length,
        rate_limited: accounts.filter((account) => account.status === 'rate_limited').length,
        pending: this.pending.length,
      },
      accounts,
    };
  }

  close() {
    this._persistState();
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    for (const item of this.pending.splice(0)) this._settle(item, new PoolError('账号池已关闭'));
  }
}

module.exports = { AccountPool, PoolError, normalizeAccounts };
