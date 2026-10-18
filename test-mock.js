'use strict';
// 集成测试：mock DeepSeek 上游 + 真实 server.js 全链路
// 运行：node test-mock.js  （无需真实 token / 网络）

const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const MOCK_PORT = 3199;
const PROXY_PORT = 3101;

// 已知答案 PoW 挑战（test.js 同款向量，求解必得 nonce=58595）
const KNOWN_CHALLENGE = {
  algorithm: 'DeepSeekHashV1',
  challenge: '168efa309e5a73033fc82dde4333bbc6515da440ef961574f73f99cbe7b397ad',
  salt: 'a40318e6b7af56bf27cf',
  signature: '68abc6d6d301b6d89a4075622ace2c909c6262860e813230bc519f78cd0aa159',
  difficulty: 144000,
  expire_at: 1790959021012,
  expire_after: 300000,
  target_path: '/api/v0/chat/completion',
};

const SSE_BODY =
  'event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"default"}\n\n' +
  'data: {"v":{"response":{"fragments":[{"id":2,"type":"THINK","content":"我们来算一下"}]}}}\n\n' +
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"一加一"}\n\n' +
  'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"1+1=2"}]}\n\n' +
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n' +
  'event: close\ndata: {}\n\n';

let lastPayload = null; // 记录上游收到的 completion body，供开关断言

function okEnvelope(bizData) {
  return JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: bizData } });
}

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url;
    if (url === '/api/v0/chat_session/create') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(okEnvelope({ chat_session: { id: 'sess-mock-1' } }));
      return;
    }
    if (url === '/api/v0/chat/create_pow_challenge') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(okEnvelope({ challenge: KNOWN_CHALLENGE }));
      return;
    }
    if (url === '/api/v0/chat/completion') {
      // 校验鉴权与 PoW 头
      assert.ok((req.headers.authorization || '').startsWith('Bearer '), '缺少 Authorization');
      const pow = JSON.parse(Buffer.from(req.headers['x-ds-pow-response'] || '', 'base64').toString('utf-8'));
      assert.strictEqual(pow.answer, 58595, `PoW 答案不正确: ${pow.answer}`);
      // 校验浏览器指纹头（缺这些会被 WAF 软拦截）
      assert.ok((req.headers['user-agent'] || '').includes('Mozilla/5.0'), '缺少浏览器 UA');
      assert.ok(req.headers['accept-language'], '缺少 accept-language');
      assert.ok(req.headers['sec-ch-ua'], '缺少 sec-ch-ua');
      assert.strictEqual(req.headers['sec-fetch-mode'], 'cors', 'sec-fetch-mode 不对');
      assert.strictEqual(req.headers['sec-fetch-site'], 'same-origin', 'sec-fetch-site 不对');
      assert.strictEqual(req.headers['sec-fetch-dest'], 'empty', 'sec-fetch-dest 不对');
      assert.ok((req.headers.origin || '').startsWith('http'), '缺少 origin');
      const payload = JSON.parse(body);
      assert.strictEqual(payload.chat_session_id, 'sess-mock-1');
      assert.strictEqual(typeof payload.prompt, 'string');
      assert.strictEqual(payload.model_type, 'default');
      lastPayload = payload;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'transfer-encoding': 'chunked',
      });
      res.write(SSE_BODY);
      setTimeout(() => res.end(), 50);
      return;
    }
    if (url === '/api/v0/chat_session/delete') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(okEnvelope({}));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 404, msg: 'not found', data: null }));
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('server 启动超时');
}

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      DS_HOST: '127.0.0.1',
      DS_PORT: String(PROXY_PORT),
      DS_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      DS_TOKEN: 'mock-token',
      DS_API_KEY: 'test-key',
    },
    stdio: 'ignore',
  });

  try {
    await waitForServer(`http://127.0.0.1:${PROXY_PORT}/health`);

    // 0. 模型列表：只有单个 deepseek-v4.1-flash
    const modelsResp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/models`, {
      headers: { authorization: 'Bearer test-key' },
    });
    const modelsJson = await modelsResp.json();
    assert.deepStrictEqual(modelsJson.data.map((m) => m.id), ['deepseek-v4.1-flash']);
    console.log('[PASS] /v1/models 仅包含 deepseek-v4.1-flash');

    // 1. 流式请求：reasoning_effort=max → thinking_enabled=true
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        stream: true,
        reasoning_effort: 'max',
        messages: [{ role: 'user', content: '1+1等于几' }],
      }),
    });
    assert.strictEqual(resp.status, 200);
    assert.ok((resp.headers.get('content-type') || '').includes('text/event-stream'));
    const text = await resp.text();
    assert.ok(text.includes('"reasoning_content"'), '缺少 reasoning 增量');
    assert.ok(text.includes('我们来算一下'), '思考文本不对');
    assert.ok(text.includes('1+1=2'), '正文不对');
    assert.ok(text.includes('"finish_reason":"stop"'), '缺少 finish_reason');
    assert.ok(text.trimEnd().endsWith('data: [DONE]'), '缺少 [DONE] 结尾');
    assert.strictEqual(lastPayload.thinking_enabled, true, 'reasoning_effort=max 应开启思考');
    assert.strictEqual(lastPayload.search_enabled, false, '默认应关闭搜索');
    console.log('[PASS] 流式请求（reasoning_effort=max → thinking_enabled=true）');

    // 2. 非流式：reasoning_effort=none → thinking 关；search_enabled=true → 搜索开
    const resp2 = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        reasoning_effort: 'none',
        search_enabled: true,
        messages: [
          { role: 'system', 'content': '你是助手' },
          { role: 'user', content: '1+1等于几' },
        ],
      }),
    });
    const json = await resp2.json();
    assert.strictEqual(json.object, 'chat.completion');
    assert.strictEqual(json.choices[0].message.content, '1+1=2');
    assert.strictEqual(json.choices[0].message.reasoning_content, '我们来算一下一加一');
    assert.ok(json.usage.total_tokens > 0);
    assert.strictEqual(lastPayload.thinking_enabled, false, 'reasoning_effort=none 应关闭思考');
    assert.strictEqual(lastPayload.search_enabled, true, 'search_enabled=true 应开启搜索');
    console.log('[PASS] 非流式请求（effort=none → thinking 关；search_enabled=true → 搜索开）');

    // 3. 其它开关写法：thinking: {type: "disabled"}
    const resp3 = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    await resp3.json();
    assert.strictEqual(lastPayload.thinking_enabled, false, 'thinking.type=disabled 应关闭思考');
    console.log('[PASS] thinking:{type:"disabled"} 写法识别');

    console.log('集成测试全部通过 ✔');
  } finally {
    child.kill();
    await new Promise((r) => mock.close(r));
  }
}

main().catch((e) => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
