'use strict';

const fs = require('fs');
const path = require('path');

const OUTCOMES = new Set(['success', 'failed', 'cancelled']);
const ERROR_KINDS = new Set([
  'auth', 'rate_limit', 'mute', 'captcha', 'upstream', 'cancelled', 'timeout',
  'queue_timeout', 'queue_full', 'pool_exhausted', 'no_accounts', 'invalid_request',
  'authentication_error', 'api_error', 'unknown',
]);

function text(value, limit = 128) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
}

function nonnegative(value) {
  return Number.isFinite(Number(value)) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number(value))) : 0;
}

function pageInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.floor(number))) : fallback;
}

function date(value, fallback) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : fallback;
}

function counters(value = {}) {
  return {
    total: Math.floor(nonnegative(value.total)),
    success: Math.floor(nonnegative(value.success)),
    failed: Math.floor(nonnegative(value.failed)),
    cancelled: Math.floor(nonnegative(value.cancelled)),
    duration_ms: nonnegative(value.duration_ms),
  };
}

function increment(target, outcome, duration) {
  target.total++;
  target[outcome]++;
  target.duration_ms += duration;
}

function summary(value) {
  const completed = value.success + value.failed;
  return {
    total: value.total,
    success: value.success,
    failed: value.failed,
    cancelled: value.cancelled,
    success_rate: completed ? value.success / completed : 0,
    average_duration_ms: value.total ? Math.round(value.duration_ms / value.total) : 0,
  };
}

// 本地单进程统计：请求与上游尝试分开计数，日志只保留运行元数据。
class Telemetry {
  constructor({ directory, maxLogBytes = 10 * 1024 * 1024, retentionFiles = 5, maxBufferedLogs = 10000, now = Date.now } = {}) {
    if (!directory || !Number.isSafeInteger(maxLogBytes) || maxLogBytes <= 0 ||
        !Number.isSafeInteger(retentionFiles) || retentionFiles < 1 || retentionFiles > 100 ||
        !Number.isSafeInteger(maxBufferedLogs) || maxBufferedLogs < 1) {
      throw new Error('日志目录、maxLogBytes 或 retentionFiles 配置无效');
    }
    this.directory = path.resolve(directory);
    this.maxLogBytes = maxLogBytes;
    this.retentionFiles = retentionFiles;
    this.maxBufferedLogs = maxBufferedLogs;
    this.now = now;
    this.persistenceError = null;
    this._state = {
      version: 1,
      started_at: new Date(this.now()).toISOString(),
      updated_at: new Date(this.now()).toISOString(),
      requests: counters(),
      attempts: counters(),
      accounts: Object.create(null),
      dropped_logs: 0,
    };
    this._visibleLogs = [];
    this._hiddenLogs = 0;
    this._pendingLogs = [];
    this._fileCounts = Array(retentionFiles).fill(0);
    this._currentLogBytes = 0;
    this._needsLogSeparator = false;
    this._dirty = true;
    this._timer = null;
    this._chain = Promise.resolve();
    this._closed = false;
    this._temporarySequence = 0;
    this._restore();
  }

  _logPath(index = 0) {
    return path.join(this.directory, index ? `requests.jsonl.${index}` : 'requests.jsonl');
  }

  _restore() {
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const statsPath = path.join(this.directory, 'stats.json');
      if (fs.existsSync(statsPath)) {
        const saved = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
        if (saved.version !== 1 || !saved.accounts || typeof saved.accounts !== 'object') {
          throw Object.assign(new Error('统计格式无效'), { code: 'INVALID_STATS' });
        }
        this._state.started_at = date(saved.started_at, this._state.started_at);
        this._state.updated_at = date(saved.updated_at, this._state.updated_at);
        this._state.requests = counters(saved.requests);
        this._state.attempts = counters(saved.attempts);
        this._state.dropped_logs = Math.floor(nonnegative(saved.dropped_logs));
        for (const [id, value] of Object.entries(saved.accounts)) {
          this._state.accounts[text(id)] = counters(value);
        }
      }
    } catch (error) {
      this._setError(error);
    }
    try {
      for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
        const match = /^requests\.jsonl\.([1-9]\d*)$/.exec(entry.name);
        if (match && Number(match[1]) >= this.retentionFiles && (entry.isFile() || entry.isSymbolicLink())) {
          fs.unlinkSync(path.join(this.directory, entry.name));
        }
      }
    } catch (error) {
      this._setError(error);
    }
    for (let index = this.retentionFiles - 1; index >= 0; index--) {
      try {
        const contents = fs.readFileSync(this._logPath(index), 'utf8');
        if (index === 0) {
          this._currentLogBytes = Buffer.byteLength(contents);
          this._needsLogSeparator = contents.length > 0 && !contents.endsWith('\n');
        }
        for (const line of contents.split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (!OUTCOMES.has(entry.outcome)) continue;
            this._remember(this._sanitize(entry));
            this._fileCounts[index]++;
          } catch { /* 忽略崩溃后未写完整的最后一行。 */ }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') this._setError(error);
      }
    }
  }

  _setError(error) {
    // 文件系统错误文本可能包含路径；管理接口只展示错误码。
    this.persistenceError = text(error.code || 'PERSISTENCE_ERROR', 64);
  }

  _remember(record) {
    this._visibleLogs.push(record);
    const excess = this._visibleLogs.length - this.maxBufferedLogs;
    if (excess > 0) {
      this._visibleLogs.splice(0, excess);
      // 内存只缓存最近记录，轮转时先扣除这些尚在磁盘上的旧记录。
      this._hiddenLogs += excess;
    }
  }

  _sanitize(entry) {
    const timestamp = new Date(this.now()).toISOString();
    const status = Math.floor(Number(entry.http_status ?? entry.status));
    return {
      request_id: text(entry.request_id),
      model: text(entry.model),
      stream: entry.stream === true,
      started_at: date(entry.started_at, timestamp),
      duration_ms: Math.round(nonnegative(entry.duration_ms)),
      status: status >= 100 && status <= 599 ? status : null,
      http_status: status >= 100 && status <= 599 ? status : null,
      outcome: OUTCOMES.has(entry.outcome) ? entry.outcome : 'failed',
      account_id: typeof entry.account_id === 'string' ? text(entry.account_id) : null,
      attempts: Math.floor(nonnegative(entry.attempts)),
      error_kind: entry.error_kind ? (ERROR_KINDS.has(entry.error_kind) ? entry.error_kind : 'unknown') : null,
    };
  }

  _schedule() {
    if (this._timer || this._closed) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.flush();
    }, 50);
    this._timer.unref();
  }

  recordRequest(entry) {
    if (this._closed) return false;
    const record = this._sanitize(entry);
    increment(this._state.requests, record.outcome, record.duration_ms);
    this._state.updated_at = new Date(this.now()).toISOString();
    if (this._pendingLogs.length < this.maxBufferedLogs) {
      this._pendingLogs.push(record);
      this._remember(record);
    } else {
      // 日志存储故障时保留统计，限制积压，丢弃数量可从管理接口查看。
      this._state.dropped_logs++;
    }
    this._dirty = true;
    this._schedule();
    return true;
  }

  recordAttempt(entry) {
    if (this._closed) return false;
    const outcome = OUTCOMES.has(entry.outcome) ? entry.outcome : 'failed';
    const duration = nonnegative(entry.duration_ms);
    increment(this._state.attempts, outcome, duration);
    if (typeof entry.account_id === 'string' && entry.account_id) {
      const id = text(entry.account_id);
      this._state.accounts[id] ||= counters();
      increment(this._state.accounts[id], outcome, duration);
    }
    this._state.updated_at = new Date(this.now()).toISOString();
    this._dirty = true;
    this._schedule();
    return true;
  }

  stats() {
    const accounts = Object.create(null);
    for (const [id, value] of Object.entries(this._state.accounts)) accounts[id] = summary(value);
    return {
      started_at: this._state.started_at,
      updated_at: this._state.updated_at,
      requests: summary(this._state.requests),
      attempts: summary(this._state.attempts),
      accounts,
      persistence_error: this.persistenceError,
      dropped_logs: this._state.dropped_logs,
      logging_warning: this.persistenceError ? 'persistence_error' :
        this._state.dropped_logs ? 'logs_dropped' : this._hiddenLogs ? 'recent_logs_limited' : null,
      recent_log_limit: this.maxBufferedLogs,
    };
  }

  getLogs({ limit = 50, offset = 0, account_id, outcome } = {}) {
    const pageLimit = pageInteger(limit, 50, 1, 200);
    const pageOffset = pageInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const filtered = this._visibleLogs.filter((entry) =>
      (account_id === undefined || entry.account_id === account_id) &&
      (outcome === undefined || entry.outcome === outcome)
    );
    return {
      data: filtered.slice().reverse().slice(pageOffset, pageOffset + pageLimit).map((entry) => ({ ...entry })),
      total: filtered.length,
      limit: pageLimit,
      offset: pageOffset,
      truncated: this._hiddenLogs > 0,
    };
  }

  async _rotate() {
    const removeIfPresent = async (filename) => {
      try { await fs.promises.unlink(filename); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
    await removeIfPresent(this._logPath(this.retentionFiles - 1));
    for (let index = this.retentionFiles - 2; index >= 0; index--) {
      try { await fs.promises.rename(this._logPath(index), this._logPath(index + 1)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const discarded = this._fileCounts.pop();
    this._fileCounts.unshift(0);
    const hiddenDiscarded = Math.min(this._hiddenLogs, discarded);
    this._hiddenLogs -= hiddenDiscarded;
    this._visibleLogs.splice(0, discarded - hiddenDiscarded);
    this._currentLogBytes = 0;
    this._needsLogSeparator = false;
  }

  flush() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._chain = this._chain.then(async () => {
      if (!this._dirty && !this._pendingLogs.length) return;
      try {
        await fs.promises.mkdir(this.directory, { recursive: true });
        const pending = this._pendingLogs.length;
        for (let index = 0; index < pending; index++) {
          const record = this._pendingLogs[0];
          let line = `${JSON.stringify(record)}\n`;
          if (this._currentLogBytes && this._currentLogBytes + Buffer.byteLength(line) > this.maxLogBytes) await this._rotate();
          // 崩溃遗留半行时先补分隔符，避免下一条完整记录与其粘连。
          if (this._needsLogSeparator) line = `\n${line}`;
          try {
            await fs.promises.appendFile(this._logPath(), line, { encoding: 'utf8', mode: 0o600 });
          } catch (error) {
            // ENOSPC 等错误可能发生在半行已写入后；恢复时先补换行。
            this._needsLogSeparator = true;
            try { this._currentLogBytes = (await fs.promises.stat(this._logPath())).size; }
            catch { /* 文件尚未创建时保持原有大小。 */ }
            throw error;
          }
          this._currentLogBytes += Buffer.byteLength(line);
          this._needsLogSeparator = false;
          this._fileCounts[0]++;
          this._pendingLogs.shift();
        }
        const serialized = JSON.stringify(this._state);
        this._dirty = false;
        const temporary = path.join(this.directory, `stats.json.tmp-${process.pid}-${++this._temporarySequence}`);
        try {
          await fs.promises.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
          await fs.promises.rename(temporary, path.join(this.directory, 'stats.json'));
        } finally {
          await fs.promises.unlink(temporary).catch(() => {});
        }
        this.persistenceError = null;
      } catch (error) {
        this._dirty = true;
        this._setError(error);
      }
    });
    return this._chain;
  }

  async close() {
    this._closed = true;
    await this.flush();
  }
}

module.exports = { Telemetry };
