#!/usr/bin/env node
'use strict';
// ds2api —— DeepSeek 网页版 → 本地 OpenAI 兼容 API 代理
//
// 把 chat.deepseek.com 的网页对话能力包装成本地 API：
//   GET  /health               健康检查
//   GET  /v1/models            模型列表
//   POST /v1/chat/completions  对话补全（支持 stream / 非 stream）
//
// 零依赖，Node.js 18+（本机验证环境 Node 24）。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UpstreamError } = require('./lib/dsweb');
const { AccountPool, PoolError } = require('./lib/pool');
const { ConfigStore } = require('./lib/config');
const { Telemetry } = require('./lib/telemetry');
const { serveAdminPage, createAdminHandler } = require('./lib/admin');
const { parseToolCalls, holdIndex, renderToolsSection, renderCallsBlock } = require('./lib/tools');

const CONFIG_PATH = path.resolve(process.env.DS_CONFIG_PATH || path.join(__dirname, 'config.json'));
const PID_PATH = process.env.DS_PID_PATH || path.join(path.dirname(CONFIG_PATH), 'server.pid');
const configStore = new ConfigStore(CONFIG_PATH);

// ---------- 配置 ----------

function loadConfig() {
  let cfg = {};
  try {
    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(path.join(__dirname, 'config.example.json'))) {
      fs.copyFileSync(path.join(__dirname, 'config.example.json'), CONFIG_PATH);
      console.log('[提示] 已从 config.example.json 生成 config.json');
    }
    cfg = configStore.read();
  } catch (e) {
    console.error(`[错误] 无法读取 config.json: ${e.message}`);
    process.exit(1);
  }
  return {
    host: process.env.DS_HOST || cfg.host || '127.0.0.1',
    port: Number(process.env.DS_PORT || cfg.port || 3210),
    apiKey: process.env.DS_API_KEY || cfg.api_key || '',
    adminKey: process.env.DS_ADMIN_KEY || cfg.admin_key || '',
    token: process.env.DS_TOKEN || cfg.token || '',
    baseUrl: process.env.DS_BASE_URL || cfg.base_url || 'https://chat.deepseek.com',
    xClientVersion: cfg.x_client_version || '2.5.0',
    deviceId: cfg.device_id || crypto.randomUUID(),
    defaultThinking: cfg.thinking_enabled ?? true,
    defaultSearch: cfg.search_enabled ?? false,
    extraHeaders: cfg.extra_headers || {},
    idleTimeoutMs: cfg.idle_timeout_ms ?? 120000,
    userAgent: cfg.user_agent || undefined,
    acceptLanguage: cfg.accept_language || undefined,
    riskHeaders: cfg.risk_headers ?? true,
    accounts: configStore.accounts(cfg),
    poolSettings: cfg.pool_settings || {},
    logging: cfg.logging || {},
    dataDirectory: path.resolve(path.dirname(CONFIG_PATH), process.env.DS_DATA_DIR || cfg.data_dir || 'data'),
  };
}

const cfg = loadConfig();

const clientOptions = {
  baseUrl: cfg.baseUrl,
  token: cfg.token,
  deviceId: cfg.deviceId,
  xClientVersion: cfg.xClientVersion,
  extraHeaders: cfg.extraHeaders,
  idleTimeoutMs: cfg.idleTimeoutMs,
  userAgent: cfg.userAgent,
  acceptLanguage: cfg.acceptLanguage,
  riskHeaders: cfg.riskHeaders,
};
const pool = new AccountPool({
  accounts: cfg.accounts,
  defaults: cfg.poolSettings,
  clientOptions,
  queueTimeoutMs: cfg.poolSettings.queue_timeout_ms ?? 30000,
  maxPending: cfg.poolSettings.max_pending ?? 100,
  stateFile: path.join(cfg.dataDirectory, 'pool-state.json'),
});
const maxAttempts = cfg.poolSettings.max_attempts ?? 3;
if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
  throw new Error('pool_settings.max_attempts 必须是 1–20 的整数');
}
const telemetry = new Telemetry({
  directory: cfg.dataDirectory,
  maxLogBytes: cfg.logging.max_log_bytes ?? 10485760,
  retentionFiles: cfg.logging.retention_files ?? 5,
});

// ---------- 模型与能力开关 ----------
//
// 网页版现在是统一模型（deepseek-v4.1-flash），思考 / 搜索是两个开关
// （thinking_enabled、search_enabled），不再有 chat / reasoner 之分。
// 思考开关跟随请求里的思考级别字段（ZCode 的选择器会映射成多种写法），
// 都没有时用 config.json 的默认值。

const MODEL_ID = 'deepseek-v4.1-flash';
const MODEL_IDS = [MODEL_ID];

function resolveFlags(body) {
  // 思考开关：显式布尔字段优先
  let thinking = null;
  const t = body.thinking;
  if (typeof body.thinking_enabled === 'boolean') thinking = body.thinking_enabled;
  else if (typeof body.enable_thinking === 'boolean') thinking = body.enable_thinking;
  else if (typeof t === 'boolean') thinking = t;
  else if (t && typeof t === 'object') {
    if (typeof t.enabled === 'boolean') thinking = t.enabled;
    else if (t.type) thinking = !(t.type === 'disabled' || t.type === 'none');
  } else if (body.reasoning && typeof body.reasoning.enabled === 'boolean') thinking = body.reasoning.enabled;

  // 其次：思考级别字段（none/disabled = 关，其余 = 开）
  if (thinking === null) {
    const effort = body.reasoning_effort ?? body.reasoning?.effort ?? body.output_config?.effort;
    if (effort !== undefined && effort !== null) {
      const e = String(effort).toLowerCase();
      thinking = !(e === 'none' || e === 'disabled');
    }
  }
  if (thinking === null) thinking = cfg.defaultThinking;

  // 搜索开关：显式字段优先，否则用配置默认
  let search = null;
  if (typeof body.search_enabled === 'boolean') search = body.search_enabled;
  else if (typeof body.web_search === 'boolean') search = body.web_search;
  else if (typeof body.search === 'boolean') search = body.search;
  if (search === null) search = cfg.defaultSearch;

  return { thinking, search };
}

// ---------- messages → 单段 prompt ----------

function textOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
      .map((p) => p.text ?? '')
      .join('\n');
  }
  return '';
}

function buildPrompt(messages, toolsSection) {
  const usable = messages.filter(
    (m) => m && (m.role === 'system' || m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
  );
  if (usable.length === 0) throw new HttpError(400, 'messages 不能为空');

  let conv;
  if (usable.length === 1 && usable[0].role === 'user') {
    // 仅一条用户消息且无系统提示时原样透传（保持网页端单轮体验）
    conv = textOf(usable[0]);
  } else {
    const parts = [];
    const systemText = usable.filter((m) => m.role === 'system').map(textOf).filter(Boolean).join('\n');
    if (systemText) parts.push(`System:\n${systemText}`);
    for (const m of usable) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        // 工具执行结果（上一轮模型发起 tool_calls 后客户端回传）
        parts.push(`Tool result (${m.name || m.tool_call_id || 'tool'}):\n${textOf(m)}`);
        continue;
      }
      // assistant 的 tool_calls 渲染回 DSML 标记，保持模型看到自己上次的调用
      const segs = [textOf(m)];
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        segs.push(renderCallsBlock(m.tool_calls));
      }
      const text = segs.filter(Boolean).join('\n');
      if (text.trim()) parts.push(`${m.role === 'user' ? 'User' : 'Assistant'}:\n${text}`);
    }
    conv = parts.join('\n\n');
  }
  return toolsSection ? `${conv}\n\n${toolsSection}` : conv;
}

// ---------- 用量估算（网页端不返回精确用量） ----------

function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  for (const ch of s) {
    if (/[　-鿿＀-￯]/.test(ch)) cjk++;
  }
  return Math.ceil(cjk * 0.6 + (s.length - cjk) / 4) || (s ? 1 : 0);
}

// ---------- HTTP 基础 ----------

class HttpError extends Error {
  constructor(status, message, type = 'invalid_request_error', code = null) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

function sendJson(res, status, obj) {
  if (res.destroyed) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, err) {
  if (res.destroyed || res.writableEnded) return;
  if (err.retryAfterMs > 0) res.setHeader('retry-after', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
  const status = err.status || 500;
  sendJson(res, status, {
    error: {
      message: err.message || '内部错误',
      type: err.type || 'api_error',
      code: err.code ?? null,
    },
  });
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function checkLocalAuth(req) {
  if (!cfg.apiKey) return;
  const got = req.headers.authorization || '';
  if (got !== `Bearer ${cfg.apiKey}`) {
    throw new HttpError(401, '本地 API Key 不正确（见 config.json 的 api_key）', 'authentication_error');
  }
}

function checkAdminAuth(req) {
  if (!cfg.adminKey) throw new HttpError(503, '管理接口未启用：请设置 admin_key 或 DS_ADMIN_KEY 后重启');
  const expected = Buffer.from('Bearer ' + cfg.adminKey);
  const actual = Buffer.from(req.headers.authorization || '');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new HttpError(401, '管理密钥不正确', 'authentication_error');
  }
}

function cancelledError() {
  return new HttpError(499, '请求已取消', 'request_cancelled');
}

function errorKind(error) {
  if (error.status === 499 || error.name === 'AbortError') return 'cancelled';
  if (error.code === 'pool_queue_full') return 'queue_full';
  if (error.code === 'pool_timeout') return 'queue_timeout';
  if (error instanceof PoolError) return 'pool_exhausted';
  return error.kind || (error.status === 400 ? 'invalid_request' : error.type || 'upstream');
}

function publicErrorMessage(error) {
  if (!(error instanceof UpstreamError)) return error.message || '上游错误';
  return {
    auth: 'DeepSeek 凭证失效，请更新账号 Token',
    rate_limit: 'DeepSeek 暂时限流，账号已进入冷却',
    mute: 'DeepSeek 账号受限，请人工处理',
    captcha: 'DeepSeek 账号需要人工验证',
  }[error.kind] || 'DeepSeek 上游连接或协议异常';
}

// 仅在当前尝试尚未产生正文或思考内容时，切换到另一可用账号。
async function* pooledChat(options, context) {
  const excluded = [];
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let lease;
    try {
      lease = await pool.acquire({ signal: options.signal, exclude: excluded });
    } catch (error) {
      if (options.signal.aborted) throw cancelledError();
      throw lastError || error;
    }
    context.accountId = lease.accountId;
    context.attempts++;
    excluded.push(lease.accountId);
    const started = Date.now();
    let outputStarted = false;
    let failure = null;
    let completed = false;
    try {
      for await (const event of lease.client.chat(options)) {
        if (options.signal.aborted) throw cancelledError();
        if (event.kind === 'delta' && event.text) outputStarted = true;
        if (event.kind !== 'meta') yield event;
      }
      if (options.signal.aborted) throw cancelledError();
      completed = true;
    } catch (error) {
      failure = options.signal.aborted ? cancelledError() : error;
    } finally {
      if (!completed && !failure) failure = cancelledError();
      lease.release(failure);
      telemetry.recordAttempt({
        account_id: lease.accountId,
        outcome: completed ? 'success' : failure.status === 499 ? 'cancelled' : 'failed',
        duration_ms: Date.now() - started, error_kind: failure ? errorKind(failure) : null,
      });
    }
    if (completed) return;
    lastError = failure;
    if (outputStarted || failure.status === 499 || attempt + 1 === maxAttempts) throw failure;
  }
  throw lastError;
}

const log = (msg) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);

// ---------- 路由 ----------

async function handleModels(req, res) {
  sendJson(res, 200, {
    object: 'list',
    data: MODEL_IDS.map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'deepseek',
    })),
  });
}

async function handleChatCompletions(req, res) {
  const started = Date.now();
  const context = {
    id: 'chatcmpl-' + crypto.randomUUID().replace(/-/g, ''),
    controller: new AbortController(), accountId: null, attempts: 0,
    model: MODEL_ID, stream: false, failure: null,
  };
  const onClose = () => { if (!res.writableEnded) context.controller.abort(); };
  req.once('aborted', onClose);
  res.once('close', onClose);
  res.setHeader('x-request-id', context.id);
  try {
    checkLocalAuth(req);
    await runChatCompletions(req, res, context);
  } catch (error) {
    context.failure = error;
    throw error;
  } finally {
    req.removeListener('aborted', onClose);
    res.removeListener('close', onClose);
    const failure = context.controller.signal.aborted ? cancelledError() : context.failure;
    telemetry.recordRequest({
      request_id: context.id, model: context.model, stream: context.stream,
      started_at: new Date(started).toISOString(), duration_ms: Date.now() - started,
      account_id: context.accountId, attempts: context.attempts,
      outcome: !failure ? 'success' : failure.status === 499 ? 'cancelled' : 'failed',
      http_status: res.headersSent ? res.statusCode : failure?.status || 200,
      error_kind: failure ? errorKind(failure) : null,
    });
  }
}

async function runChatCompletions(req, res, context) {
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求体必须是 JSON 对象');
  if (!Array.isArray(body.messages)) throw new HttpError(400, '缺少 messages 数组');
  const model = body.model || MODEL_ID;
  const stream = !!body.stream;
  context.model = model;
  context.stream = stream;
  const { thinking, search } = resolveFlags(body);

  // 工具调用：把 tools 渲染进提示词；tool_choice=none 则不注入也不识别调用标记
  const toolChoice = body.tool_choice;
  const noTools = toolChoice === 'none' || toolChoice?.type === 'none';
  const toolsArr = Array.isArray(body.tools) ? body.tools : [];
  const toolsSection = toolsArr.length && !noTools ? renderToolsSection(toolsArr, toolChoice) : null;
  const prompt = buildPrompt(body.messages, toolsSection);

  const id = context.id;
  const created = Math.floor(Date.now() / 1000);
  const gen = pooledChat({
    prompt,
    thinkingEnabled: thinking,
    searchEnabled: search,
    signal: context.controller.signal,
  }, context);

  const started = Date.now();
  let reasoning = '';
  let content = '';
  let usageUpstream = null;

  if (stream) {
    // 等待首个正文/思考/完成事件后发送 SSE 头，使分配失败仍返回正确 HTTP 状态。
    const first = await gen.next();
    async function* events() {
      try {
        if (!first.done) yield first.value;
        yield* gen;
      } finally {
        await gen.return();
      }
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const chunk = (delta, finishReason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`
      );

    try {
      chunk({ role: 'assistant', content: '' });
      let emitted = 0; // 已作为正文增量发出的 content 前缀长度
      for await (const ev of events()) {
        if (ev.kind === 'delta') {
          if (ev.type === 'reasoning') {
            reasoning += ev.text;
            chunk({ reasoning_content: ev.text });
          } else {
            content += ev.text;
            // 工具调用标记（含未定形的尾部前缀）先扣住，避免泄漏成正文
            const safe = noTools ? content.length : holdIndex(content);
            if (safe > emitted) {
              chunk({ content: content.slice(emitted, safe) });
              emitted = safe;
            }
          }
        } else if (ev.kind === 'done') {
          usageUpstream = ev.usage;
        }
      }
      // 收尾：补发扣住的正文，再把工具调用以 tool_calls 增量发出
      const calls = [];
      if (!noTools) {
        const tail = parseToolCalls(content.slice(emitted)).text;
        if (tail) chunk({ content: tail });
        calls.push(...parseToolCalls(content).calls);
      }
      if (calls.length) {
        calls.forEach((c, i) =>
          chunk({
            tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }],
          })
        );
        chunk({}, 'tool_calls');
      } else {
        chunk({}, 'stop');
      }
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: buildUsage(prompt, content + reasoning, usageUpstream),
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      context.failure = e;
      if (res.destroyed) return;
      // 流已开始，只能以 SSE 错误帧收尾
      const message = publicErrorMessage(e);
      res.write(`data: ${JSON.stringify({ error: { message, type: e.name || 'api_error' } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } else {
    try {
      for await (const ev of gen) {
        if (ev.kind === 'delta') {
          if (ev.type === 'reasoning') reasoning += ev.text;
          else content += ev.text;
        } else if (ev.kind === 'done') {
          usageUpstream = ev.usage;
        }
      }
      const parsed = noTools ? { text: content, calls: [] } : parseToolCalls(content);
      const toolCalls = parsed.calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }));
      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: toolCalls.length ? parsed.text || null : parsed.text,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
              ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
          },
        ],
        usage: buildUsage(prompt, content + reasoning, usageUpstream),
      });
    } catch (e) {
      throw e;
    }
  }
  log(
    `${req.method} /v1/chat/completions model=${model} stream=${stream} thinking=${thinking} search=${search} ` +
      `tools=${toolsArr.length} ${Date.now() - started}ms len(content)=${content.length}`
  );
}

function buildUsage(prompt, outputText, upstreamUsage) {
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(outputText);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: upstreamUsage ?? promptTokens + completionTokens,
  };
}

const handleAdmin = createAdminHandler({
  store: configStore, pool, telemetry, readBody, sendJson, HttpError,
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (serveAdminPage(req, res, url.pathname)) return;
    if (url.pathname === '/admin/api' || url.pathname.startsWith('/admin/api/')) {
      checkAdminAuth(req);
      return await handleAdmin(req, res, url);
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      sendJson(res, 200, {
        ok: true,
        name: 'ds2api',
        upstream: cfg.baseUrl,
        token_configured: pool.snapshot().accounts.some((account) => account.token_configured),
        models: MODEL_IDS,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return await handleChatCompletions(req, res);
    checkLocalAuth(req);
    if (req.method === 'GET' && url.pathname === '/v1/models') return await handleModels(req, res);
    throw new HttpError(404, `未知路径 ${req.method} ${url.pathname}`, 'invalid_request_error');
  } catch (e) {
    if (e instanceof UpstreamError) {
      log('上游错误 kind=' + e.kind + ' status=' + e.status);
      const safeError = new HttpError(e.status, publicErrorMessage(e), 'upstream_' + e.kind,
        Number.isSafeInteger(e.code) ? e.code : null);
      safeError.retryAfterMs = e.retryAfterMs;
      sendError(res, safeError);
    } else if (e instanceof HttpError || e instanceof PoolError) {
      if (e.status !== 404) log(`请求被拒 [${e.status}]: ${e.message}`);
      sendError(res, e);
    } else {
      log(`内部错误: ${e.stack || e.message}`);
      sendError(res, new HttpError(500, '代理内部错误', 'api_error'));
    }
  }
});

// ---------- 启动 ----------

server.listen(cfg.port, cfg.host, () => {
  try {
    fs.writeFileSync(PID_PATH, String(process.pid));
  } catch { /* 忽略 */ }
  log('='.repeat(56));
  log(`ds2api 已启动  http://${cfg.host}:${cfg.port}`);
  log(`上游: ${cfg.baseUrl}`);
  log('号池账号数: ' + pool.snapshot().summary.total);
  log('管理台: http://' + cfg.host + ':' + cfg.port + '/admin（' + (cfg.adminKey ? '已配置独立管理密钥' : '请配置 admin_key') + '）');
  log(`示例: curl http://${cfg.host}:${cfg.port}/v1/models`);
  log('='.repeat(56));
});

// 网页管理变更立即生效；CLI 登录或手改 accounts 也无需重启。
fs.watchFile(CONFIG_PATH, { interval: 1000, persistent: false }, () => {
  try { pool.setAccounts(configStore.accounts()); }
  catch { log('账号配置未加载：请检查 accounts 格式，当前账号配置继续使用'); }
});

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    fs.unwatchFile(CONFIG_PATH);
    pool.close();
    log('收到退出信号，正在关闭…');
    try {
      fs.unlinkSync(PID_PATH);
    } catch { /* 忽略 */ }
    const forced = setTimeout(async () => {
      server.closeAllConnections();
      await telemetry.close();
      process.exit(0);
    }, 5000);
    forced.unref();
    server.close(async () => {
      clearTimeout(forced);
      await telemetry.close();
      process.exit(0);
    });
  });
}
