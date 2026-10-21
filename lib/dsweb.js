'use strict';
// DeepSeek 网页版（chat.deepseek.com/api/v0）协议客户端
//
// 协议要点（依据多个开源 web2api 项目的 2026-10 实现交叉核对）：
//   - 鉴权：Authorization: Bearer <token>（浏览器存于 localStorage.userToken）
//   - 每个 /chat/completion 前需 POST /chat/create_pow_challenge 获取挑战，
//     求解后以 x-ds-pow-response 头随请求携带
//   - POST /chat/completion 的响应本身就是 SSE 流，事件与 JSON 补丁协议：
//       event: ready  → {request_message_id, response_message_id}
//       data: {"p":<路径>,"o":<SET|APPEND|BATCH>,"v":<值>}（p/o 可省略）
//       文本增量：response/fragments/-1/content（THINK 片段=思考，RESPONSE=正文；
//       旧版为 response/thinking_content 与 response/content）
//       结束：response/status → "FINISHED"，然后 event: close
//       错误：event: toast → {type:"error", content, finish_reason}

const { solveChallenge } = require('./pow');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function abortError() {
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 2147483647000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.min(timestamp - now, 2147483647000)) : 0;
}

// 由 UA 推导 Chrome 系 client hints，保持指纹一致
function clientHintsFor(ua) {
  const hints = {};
  const chrome = /Chrome\/(\d+)/.exec(ua);
  const edge = /Edg\/(\d+)/.exec(ua);
  if (edge) {
    hints['sec-ch-ua'] = `"Chromium";v="${edge[1]}", "Microsoft Edge";v="${edge[1]}", "Not_A Brand";v="24"`;
  } else if (chrome) {
    hints['sec-ch-ua'] = `"Not)A;Brand";v="99", "Google Chrome";v="${chrome[1]}", "Chromium";v="${chrome[1]}"`;
  }
  // Firefox 不发送 client hints
  if (/Firefox\//.test(ua)) return {};
  hints['sec-ch-ua-mobile'] = '?0';
  if (/Windows NT/.test(ua)) hints['sec-ch-ua-platform'] = '"Windows"';
  else if (/Mac OS X/.test(ua)) hints['sec-ch-ua-platform'] = '"macOS"';
  else if (/Android/.test(ua)) {
    hints['sec-ch-ua-platform'] = '"Android"';
    hints['sec-ch-ua-mobile'] = '?1';
  } else if (/Linux/.test(ua)) hints['sec-ch-ua-platform'] = '"Linux"';
  else hints['sec-ch-ua-platform'] = '"Windows"';
  return hints;
}

class UpstreamError extends Error {
  constructor(message, { status = 502, kind = 'upstream', code = null, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.kind = kind; // auth | rate_limit | mute | captcha | upstream
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function classifyError(message, status, bizCode) {
  const text = String(message || '');
  if (status === 401 || status === 403 || bizCode === 40002 || bizCode === 40003) return 'auth';
  if (status === 429 || status === 503 || /rate.?limit|too many|frequent|频繁/i.test(text)) return 'rate_limit';
  if (bizCode === 5 || /mute|禁言/i.test(text)) return 'mute';
  if (/captcha|hcaptcha|shumei|verification|验证码|数美|风控/i.test(text)) return 'captcha';
  return 'upstream';
}

function statusForKind(kind) {
  return { auth: 401, rate_limit: 429, mute: 403, captcha: 429 }[kind] || 502;
}

// 解开服务端信封：{code,msg,data:{biz_code,biz_msg,biz_data}}
function unwrap(json, httpStatus, retryAfterMs = 0) {
  if (!json || typeof json !== 'object') {
    const kind = classifyError(json, httpStatus, null);
    throw new UpstreamError('上游返回了无法解析的内容', { status: statusForKind(kind), kind, retryAfterMs });
  }
  const code = json.code ?? 0;
  const bizCode = json.data?.biz_code ?? code;
  const msg = json.data?.biz_msg || json.msg || '';
  if (code !== 0 || bizCode !== 0) {
    const kind = classifyError(msg || `code=${bizCode}`, httpStatus, bizCode);
    throw new UpstreamError(msg || `上游错误 code=${bizCode}`, {
      status: statusForKind(kind),
      kind,
      code: bizCode,
      retryAfterMs,
    });
  }
  return json.data?.biz_data ?? json.data ?? json;
}

// SSE 帧解析器：喂字节 → 吐 {event, data} 帧
class SseParser {
  constructor() {
    this.buf = '';
    this.event = null;
    this.dataLines = [];
  }
  push(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.search(/\r?\n\r?\n/)) >= 0) {
      const rawEnd = idx + (this.buf[idx] === '\r' ? 4 : 2);
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(rawEnd);
      const frame = this.#parseBlock(block);
      if (frame) return frame;
    }
    return null;
  }
  *drain(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.search(/\r?\n\r?\n/)) >= 0) {
      const rawEnd = idx + (this.buf[idx] === '\r' ? 4 : 2);
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(rawEnd);
      const frame = this.#parseBlock(block);
      if (frame) yield frame;
    }
  }
  #parseBlock(block) {
    let event = null;
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue; // 心跳注释
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join('\n') };
  }
}

class DeepSeekClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || 'https://chat.deepseek.com').replace(/\/+$/, '');
    this.token = opts.token || '';
    this.deviceId = opts.deviceId || crypto.randomUUID();
    this.xClientVersion = opts.xClientVersion || '2.5.0';
    this.locale = opts.locale || 'zh_CN';
    this.timezoneOffset = opts.timezoneOffset ?? 28800;
    this.extraHeaders = opts.extraHeaders || {};
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 120000;
    this.userAgent = opts.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    this.acceptLanguage = opts.acceptLanguage || 'zh-CN,zh;q=0.9,en;q=0.8';
    // 2026 年风控头（x-hif-leim / x-hs-dliq）：仅当上游是 deepseek.com 时自动获取
    this.riskHeaders = opts.riskHeaders !== false && /(^|\.)deepseek\.com$/i.test(new URL(this.baseUrl).hostname);
    this.hifHeaders = {};
    this.hifExpires = 0;
    this.hifInflight = null;
    this._deleteChain = Promise.resolve();
  }

  // 完整浏览器指纹请求头：缺这些头会被 WAF 软拦截（返回 429 HTML）
  headers(extra = {}) {
    return {
      'authorization': `Bearer ${this.token}`,
      'content-type': 'application/json',
      'accept': 'application/json, text/plain, */*',
      'accept-language': this.acceptLanguage,
      'origin': this.baseUrl,
      'referer': `${this.baseUrl}/`,
      'user-agent': this.userAgent,
      // XHR/fetch 的 sec-fetch 三件套
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      ...clientHintsFor(this.userAgent),
      'x-client-bundle-id': 'com.deepseek.chat',
      'x-client-locale': this.locale,
      'x-client-platform': 'web',
      'x-client-timezone-offset': String(this.timezoneOffset),
      'x-client-version': this.xClientVersion,
      'x-device-id': this.deviceId,
      'x-device-model': '',
      ...this.hifHeaders,
      ...this.extraHeaders, // 用户自定义头优先级最高（含 cookie 等）
      ...extra,
    };
  }

  // 风控头自动获取（GET hif-*.deepseek.com/query → 信封 data.biz_data.value），10 分钟内缓存
  async refreshHif() {
    if (!this.riskHeaders) return;
    if (this.hifHeaders && Date.now() < this.hifExpires) return;
    if (this.hifInflight) return this.hifInflight;
    this.hifInflight = (async () => {
      try {
        const grab = async (host) => {
          const resp = await fetch(`https://${host}/query`, {
            headers: {
              'user-agent': this.userAgent,
              'accept': 'application/json, text/plain, */*',
              'accept-language': this.acceptLanguage,
            },
            signal: AbortSignal.timeout(5000),
          });
          const json = await resp.json();
          return json?.data?.biz_data?.value || null;
        };
        const [leim, dliq] = await Promise.all([
          grab('hif-leim.deepseek.com'),
          grab('hif-dliq.deepseek.com'),
        ]);
        const h = {};
        if (leim) h['x-hif-leim'] = leim;
        if (dliq) h['x-hif-dliq'] = dliq;
        if (Object.keys(h).length) {
          this.hifHeaders = h;
          this.hifExpires = Date.now() + 10 * 60 * 1000;
        }
      } catch {
        // 风控头获取失败不阻塞主流程
      } finally {
        this.hifInflight = null;
      }
    })();
    return this.hifInflight;
  }

  // 网络层容错：连接抖动（fetch failed）自动重试，最终失败转成干净的 UpstreamError
  async #fetchSafe(url, options, attempts = 2) {
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fetch(url, options);
      } catch (e) {
        if (options.signal?.aborted || e?.name === 'AbortError' || e?.name === 'TimeoutError') throw e;
        lastErr = e;
      }
    }
    throw new UpstreamError(
      `上游连接失败：${lastErr?.cause?.code || lastErr?.message || lastErr}`,
      { status: 502, kind: 'upstream' }
    );
  }

  async #json(method, path, body, extraHeaders, signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.idleTimeoutMs);
    try {
      await waitWithSignal(this.refreshHif(), controller.signal);
      const resp = await this.#fetchSafe(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(extraHeaders),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await resp.text();
      const retryAfter = retryAfterMs(resp.headers.get('retry-after'));
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        const kind = classifyError(text, resp.status, null);
        throw new UpstreamError(`上游返回非 JSON（HTTP ${resp.status}）：${text.slice(0, 200)}`,
          { status: statusForKind(kind), kind, retryAfterMs: retryAfter });
      }
      const result = unwrap(json, resp.status, retryAfter);
      if (!resp.ok) {
        const kind = classifyError(text, resp.status, null);
        throw new UpstreamError(`上游 HTTP ${resp.status}`, { status: statusForKind(kind), kind, retryAfterMs: retryAfter });
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new UpstreamError(signal?.aborted ? '请求已取消' : '上游响应超时',
          { status: signal?.aborted ? 499 : 504, kind: signal?.aborted ? 'cancelled' : 'upstream' });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // ---------- 账号 ----------

  static async login({ baseUrl, email, password, mobile, areaCode, deviceId, userAgent, acceptLanguage, extraHeaders, riskHeaders }) {
    const client = new DeepSeekClient({ baseUrl, deviceId, userAgent, acceptLanguage, extraHeaders, riskHeaders });
    const body = mobile
      ? { mobile, area_code: areaCode ?? null, password, device_id: 'deepseek_to_api', os: 'android' }
      : { email, password, device_id: 'deepseek_to_api', os: 'android' };
    const data = await client.#json('POST', '/api/v0/users/login', body);
    const token = data?.user?.token || data?.token;
    if (!token) throw new UpstreamError('登录响应中未找到 token', { kind: 'auth' });
    return token;
  }

  async me(signal) {
    return this.#json('GET', '/api/v0/users/current', undefined, undefined, signal);
  }

  // ---------- PoW ----------

  async powHeader(targetPath, signal) {
    // 挑战是一次性的：复用已解出的挑战会被拒（INVALID_POW_RESPONSE），每次都取新挑战
    const biz = await this.#json('POST', '/api/v0/chat/create_pow_challenge', { target_path: targetPath }, undefined, signal);
    const challenge = biz?.challenge || biz;
    if (!challenge?.challenge) {
      throw new UpstreamError('未获得 PoW 挑战（token 可能已过期）', { kind: 'auth', status: 401 });
    }
    const solved = await waitWithSignal(solveChallenge(challenge), signal);
    return solved.header;
  }

  // ---------- 会话 ----------

  async createSession(signal) {
    const biz = await this.#json('POST', '/api/v0/chat_session/create', {}, undefined, signal);
    return biz?.chat_session?.id || biz?.id;
  }

  // 会话删除是风控敏感操作（连续删除会 429），串行 + 限速，失败静默
  scheduleDeleteSession(sessionId) {
    if (!sessionId) return;
    this._deleteChain = this._deleteChain
      .then(() => sleep(1500))
      .then(() => this.#json('POST', '/api/v0/chat_session/delete', { chat_session_id: sessionId }).catch(() => {}))
      .catch(() => {});
  }

  // ---------- 对话 ----------

  /**
   * 发起一轮对话，异步产出事件：
   *   {kind:'meta', requestId, responseId, modelType}
   *   {kind:'delta', type:'content'|'reasoning', text}
   *   {kind:'done', finishReason, usage}
   * 错误抛 UpstreamError。
   */
  async *chat({ prompt, thinkingEnabled = true, searchEnabled = false, signal }) {
    let sessionId = null;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let idleTimer = null;
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), this.idleTimeoutMs);
    };
    bumpIdle();

    try {
      if (controller.signal.aborted) throw abortError();
      sessionId = await this.createSession(controller.signal);
      const body = {
        chat_session_id: sessionId,
        parent_message_id: null,
        model_type: 'default',
        prompt,
        ref_file_ids: [],
        stream: true,
        thinking_enabled: !!thinkingEnabled,
        search_enabled: !!searchEnabled,
        action: null,
        preempt: false,
      };
      await waitWithSignal(this.refreshHif(), controller.signal);
      // 每次尝试都取一次性 PoW 挑战；挑战被拒（INVALID_POW_RESPONSE）时换新挑战重试一次
      let resp = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        let r = null;
        try {
          const pow = await this.powHeader('/api/v0/chat/completion', controller.signal);
          r = await this.#fetchSafe(`${this.baseUrl}/api/v0/chat/completion`, {
            method: 'POST',
            headers: this.headers({ 'x-ds-pow-response': pow }),
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (e) {
          if (controller.signal.aborted || e?.name === 'AbortError' || e?.name === 'TimeoutError') throw e;
          // 网络层失败或 PoW 挑战获取失败 → 换新挑战整体重试一次
          const netErr = e instanceof UpstreamError
            ? e
            : new UpstreamError(`上游连接失败：${e?.cause?.code || e?.message || e}`, { status: 502, kind: 'upstream' });
          if (attempt === 2 || ['auth', 'rate_limit', 'mute', 'captcha', 'cancelled'].includes(netErr.kind) ||
            [401, 429, 499].includes(netErr.status)) throw netErr;
          continue;
        }
        if (r.ok && (r.headers.get('content-type') || '').includes('text/event-stream')) {
          resp = r;
          break;
        }
        // 非事件流 = 出错信封（或罕见的非流成功）
        const text = await r.text();
        const retryAfter = retryAfterMs(r.headers.get('retry-after'));
        let err = null;
        try {
          unwrap(JSON.parse(text), r.status, retryAfter);
          err = new UpstreamError(`上游未返回事件流（HTTP ${r.status}）`, {
            status: statusForKind(classifyError(text, r.status, null)),
            kind: classifyError(text, r.status, null),
            retryAfterMs: retryAfter,
          });
        } catch (e) {
          err = e instanceof UpstreamError
            ? e
            : new UpstreamError(`上游未返回事件流（HTTP ${r.status}）`, {
                status: statusForKind(classifyError(text, r.status, null)),
                kind: classifyError(text, r.status, null),
                retryAfterMs: retryAfter,
              });
        }
        const isPowError = err?.code === 40301 || /INVALID_POW/i.test(err?.message || '');
        if (!isPowError || attempt === 2) throw err;
      }
      if (!resp) throw new UpstreamError('上游未返回事件流', { status: 502 });

      const state = new StreamState();
      const parser = new SseParser();
      const decoder = new TextDecoder('utf-8');
      for await (const chunk of resp.body) {
        bumpIdle();
        for (const frame of parser.drain(decoder.decode(chunk, { stream: true }))) {
          for (const ev of state.handleFrame(frame)) {
            if (ev.kind === 'delta' && ev.text) yield ev;
            else if (ev.kind !== 'delta') yield ev;
          }
        }
      }
      if (!state.finished) throw new UpstreamError('上游流意外中断', { status: 502, kind: 'upstream' });
      yield state.finish();
    } catch (e) {
      if (controller.signal.aborted || e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        throw new UpstreamError(signal?.aborted ? '请求已取消' : '上游响应超时',
          { status: signal?.aborted ? 499 : 504, kind: signal?.aborted ? 'cancelled' : 'upstream' });
      }
      throw e;
    } finally {
      clearTimeout(idleTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      controller.abort();
      this.scheduleDeleteSession(sessionId);
    }
  }
}

// SSE 补丁协议状态机
class StreamState {
  constructor() {
    this.fragTypes = []; // 每个 fragment 的类型 THINK / RESPONSE / SEARCH
    this.fragAcc = []; // 每个 fragment 已累计的文本
    this.contentAcc = '';
    this.reasoningAcc = '';
    this.emittedContent = 0;
    this.emittedReasoning = 0;
    this.lastPath = null;
    this.finished = false;
    this.finishReason = 'stop';
    this.usage = null;
    this.meta = {};
  }

  sinkFor(type) {
    return type === 'THINK' ? 'reasoning' : type === 'RESPONSE' ? 'content' : null;
  }

  #delta(sink, fullText) {
    // fullText 是该 sink 的最新全文，只发新增部分
    if (sink === 'content') {
      const d = fullText.slice(this.emittedContent);
      this.emittedContent = fullText.length;
      return d ? { kind: 'delta', type: 'content', text: d } : null;
    }
    if (sink === 'reasoning') {
      const d = fullText.slice(this.emittedReasoning);
      this.emittedReasoning = fullText.length;
      return d ? { kind: 'delta', type: 'reasoning', text: d } : null;
    }
    return null;
  }

  #accumulate(sink, text) {
    if (sink === 'content') this.contentAcc += text;
    else if (sink === 'reasoning') this.reasoningAcc += text;
  }

  handleFrame({ event, data }) {
    const out = [];
    if (data === '[DONE]') {
      this.finished = true;
      return out;
    }
    let obj = null;
    try {
      obj = JSON.parse(data);
    } catch {
      return out;
    }

    if (event === 'ready') {
      this.meta.requestId = obj.request_message_id;
      this.meta.responseId = obj.response_message_id;
      this.meta.modelType = obj.model_type;
      out.push({ kind: 'meta', ...this.meta });
      return out;
    }
    if (event === 'close') {
      this.finished = true;
      return out;
    }
    if (event === 'toast') {
      if (obj?.type === 'error') {
        const kind = classifyError(obj.content, null, null);
        throw new UpstreamError(obj.content || '上游 toast 错误', {
          status: statusForKind(kind),
          kind,
        });
      }
      return out;
    }
    if (event === 'title' || event === 'update_session') return out;
    if (event) return out; // 未知事件忽略

    // 无 event 名的补丁帧
    for (const p of expandPatches(obj, this.lastPath)) {
      if (p.path) this.lastPath = p.path;
      this.#applyPatch(p.path, p.op, p.value, out);
    }
    return out;
  }

  #applyPatch(path, op, value, out) {
    if (!path) {
      // 根级整包（{"v":{"response":{...fragments...}}}）
      const frags = value?.response?.fragments;
      if (Array.isArray(frags)) this.#mergeFragments(frags, out);
      return;
    }
    if (path === 'response/fragments') {
      if (Array.isArray(value)) this.#mergeFragments(value, out);
      return;
    }
    const m = path.match(/^response\/fragments\/(-?\d+)\/content$/);
    if (m) {
      const idx = m[1] === '-1' ? this.fragTypes.length - 1 : Number(m[1]);
      const type = this.fragTypes[idx];
      const sink = this.sinkFor(type);
      if (!sink) return;
      const prev = this.fragAcc[idx] || '';
      const full = op === 'SET' && typeof value === 'string' ? value : prev + (value ?? '');
      this.fragAcc[idx] = full;
      this.#accumulate(sink, full.slice(prev.length));
      const ev = this.#delta(sink, sink === 'content' ? this.contentAcc : this.reasoningAcc);
      if (ev) out.push(ev);
      return;
    }
    if (path === 'response/content' || path === 'response/thinking_content') {
      const sink = path === 'response/content' ? 'content' : 'reasoning';
      const prev = sink === 'content' ? this.contentAcc : this.reasoningAcc;
      // 旧版协议：SET 用全文覆盖、APPEND 追加
      const full = op === 'SET' ? String(value ?? '') : prev + String(value ?? '');
      if (sink === 'content') this.contentAcc = full;
      else this.reasoningAcc = full;
      const ev = this.#delta(sink, full);
      if (ev) out.push(ev);
      return;
    }
    if (path === 'response/status' && value === 'FINISHED') {
      this.finished = true;
      this.finishReason = 'stop';
      return;
    }
    if (path === 'response/quasi_status' && value === 'FINISHED') {
      this.finished = true;
    }
    if (path === 'response/accumulated_token_usage' && typeof value === 'number') {
      this.usage = value;
    }
  }

  #mergeFragments(frags, out) {
    for (const frag of frags) {
      const idx = this.fragTypes.length;
      this.fragTypes.push(frag.type);
      const sink = this.sinkFor(frag.type);
      const text = frag.content ?? '';
      const prev = '';
      this.fragAcc[idx] = text;
      if (sink) {
        this.#accumulate(sink, text);
        const ev = this.#delta(sink, sink === 'content' ? this.contentAcc : this.reasoningAcc);
        if (ev) out.push(ev);
      }
    }
    this.lastPath = 'response/fragments/-1/content';
  }

  finish() {
    return {
      kind: 'done',
      finishReason: this.finishReason,
      usage: this.usage,
      content: this.contentAcc,
      reasoning: this.reasoningAcc,
    };
  }
}

// 把一帧补丁展开为 [{path, op, value}]，处理省略 p/o 与 BATCH 嵌套。
// 顶层补丁的 p 是绝对路径（省略 p = 沿用上一条路径）；BATCH 子补丁的 p 相对父路径。
function expandPatches(obj, lastPath) {
  const out = [];
  const walk = (o, basePath, nested) => {
    let path;
    if (o.p) path = nested ? resolvePath(basePath, o.p) : o.p;
    else path = basePath;
    const op = o.o || (isContentPath(path) ? 'APPEND' : 'SET');
    if (op === 'BATCH' && Array.isArray(o.v)) {
      for (const sub of o.v) walk(sub, path, true);
      return;
    }
    out.push({ path, op, value: o.v });
  };
  walk(obj, lastPath, false);
  return out;
}

function resolvePath(base, p) {
  if (!base) return p;
  if (p === base || p.startsWith(base + '/')) return p;
  return `${base}/${p}`;
}

function isContentPath(p) {
  return (
    p === 'response/content' ||
    p === 'response/thinking_content' ||
    /^response\/fragments\/-?\d+\/content$/.test(p || '')
  );
}

module.exports = { DeepSeekClient, UpstreamError, SseParser, StreamState, expandPatches, classifyError, statusForKind };
