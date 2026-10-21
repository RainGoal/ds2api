'use strict';

// Only talks to the ephemeral HTTP server below; never contacts DeepSeek.
const assert = require('assert');
const http = require('http');
const { DeepSeekClient, UpstreamError } = require('./lib/dsweb');

const challenge = {
  algorithm: 'DeepSeekHashV1',
  challenge: '168efa309e5a73033fc82dde4333bbc6515da440ef961574f73f99cbe7b397ad',
  salt: 'a40318e6b7af56bf27cf',
  signature: '68abc6d6d301b6d89a4075622ace2c909c6262860e813230bc519f78cd0aa159',
  difficulty: 144000, expire_at: 1790959021012, target_path: '/api/v0/chat/completion',
};
const partial = 'data: {"p":"response/content","o":"APPEND","v":"partial"}\n\n';
const finished = partial + 'data: {"p":"response/status","v":"FINISHED"}\n\n';
const envelope = (value) => ({ code: 0, data: { biz_code: 0, biz_data: value } });
const collect = async (gen, events = []) => { for await (const event of gen) events.push(event); return events; };

async function main() {
  const fixtures = new Map();
  const mock = http.createServer((req, res) => {
    const mode = (req.headers.authorization || '').replace('Bearer ', '');
    const fixture = fixtures.get(mode);
    if (!fixture) { res.writeHead(500); res.end('unknown test'); return; }
    fixture.counts[req.url] = (fixture.counts[req.url] || 0) + 1;
    req.resume();
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/v0/chat_session/delete') {
      json(200, envelope({}));
    } else if (req.url === '/api/v0/chat_session/create') {
      if (mode === 'create429') json(429, { code: 1, msg: 'too many requests' }, { 'retry-after': '4' });
      else if (['cancel-create', 'timeout-create'].includes(mode)) {
        fixture.started();
        res.on('close', () => { fixture.closed = true; });
      } else json(200, envelope({ chat_session: { id: `session-${mode}` } }));
    } else if (req.url === '/api/v0/chat/create_pow_challenge') {
      if (mode === 'pow401') json(401, { code: 40002, msg: 'expired' });
      else if (mode === 'pow429') json(429, { code: 1, msg: 'too many requests' }, { 'retry-after': '3' });
      else if (mode === 'cancel-pow') {
        fixture.started();
        res.on('close', () => { fixture.closed = true; });
      } else json(200, envelope({ challenge }));
    } else if (req.url === '/api/v0/chat/completion') {
      if (mode === 'complete429') {
        const retryDate = new Date(Date.now() + 6000).toUTCString();
        json(429, { code: 1, msg: 'too many requests' }, { 'retry-after': retryDate });
      } else if (mode === 'plain429') {
        res.writeHead(429, { 'content-type': 'text/html', 'retry-after': '7' });
        res.end('<html>rate limited</html>');
      } else if (mode === 'pow-retry' && fixture.counts[req.url] === 1) {
        json(200, { code: 40301, msg: 'INVALID_POW_RESPONSE' });
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(mode === 'truncated' ? partial : finished);
      }
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${mock.address().port}`;
  function client(mode, options = {}) {
    let started;
    const waiting = new Promise((resolve) => { started = resolve; });
    const fixture = { counts: {}, cleanups: [], started, waiting, closed: false };
    fixtures.set(mode, fixture);
    const instance = new DeepSeekClient({ baseUrl, token: mode, riskHeaders: false, idleTimeoutMs: 1000, ...options });
    const originalDelete = instance.scheduleDeleteSession.bind(instance);
    instance.scheduleDeleteSession = (id) => {
      if (id) fixture.cleanups.push(id);
      if (mode === 'cancel-pow') originalDelete(id);
    };
    return { instance, fixture };
  }
  try {
    let test = client('create429');
    await assert.rejects(collect(test.instance.chat({ prompt: 'x' })),
      (error) => error instanceof UpstreamError && error.status === 429 && error.retryAfterMs === 4000);
    assert.strictEqual(test.fixture.counts['/api/v0/chat_session/create'], 1);
    console.log('[PASS] 创建会话的 Retry-After 秒数及 429 不重试');

    for (const mode of ['pow401', 'pow429']) {
      test = client(mode);
      await assert.rejects(collect(test.instance.chat({ prompt: 'x' })),
        (error) => error.status === (mode === 'pow401' ? 401 : 429) && (mode !== 'pow429' || error.retryAfterMs === 3000));
      assert.strictEqual(test.fixture.counts['/api/v0/chat/create_pow_challenge'], 1);
      assert.strictEqual(test.fixture.counts['/api/v0/chat/completion'], undefined);
      assert.deepStrictEqual(test.fixture.cleanups, [`session-${mode}`]);
    }
    console.log('[PASS] PoW 鉴权/限流不在同账号重复获取并清理会话');

    test = client('complete429');
    await assert.rejects(collect(test.instance.chat({ prompt: 'x' })),
      (error) => error.status === 429 && error.retryAfterMs >= 4000 && error.retryAfterMs <= 6000);
    assert.strictEqual(test.fixture.counts['/api/v0/chat/completion'], 1);
    test = client('plain429');
    await assert.rejects(collect(test.instance.chat({ prompt: 'x' })),
      (error) => error.status === 429 && error.retryAfterMs === 7000);
    console.log('[PASS] completion 的 HTTP 日期与非 JSON Retry-After');

    test = client('pow-retry');
    assert.ok((await collect(test.instance.chat({ prompt: 'x' }))).some((event) => event.kind === 'done'));
    assert.strictEqual(test.fixture.counts['/api/v0/chat/create_pow_challenge'], 2);
    assert.strictEqual(test.fixture.counts['/api/v0/chat/completion'], 2);
    console.log('[PASS] PoW 失效仍会换新挑战重试');

    test = client('truncated');
    const events = [];
    await assert.rejects(collect(test.instance.chat({ prompt: 'x' }), events), /上游流意外中断/);
    assert.ok(events.some((event) => event.kind === 'delta' && event.text === 'partial'));
    assert.ok(!events.some((event) => event.kind === 'done'));
    assert.deepStrictEqual(test.fixture.cleanups, ['session-truncated']);
    console.log('[PASS] SSE 截断不能被记为成功');

    const preabort = new AbortController();
    preabort.abort();
    test = client('pre-aborted');
    await assert.rejects(collect(test.instance.chat({ prompt: 'x', signal: preabort.signal })), (error) => error.status === 499);
    assert.deepStrictEqual(test.fixture.counts, {});
    for (const mode of ['cancel-create', 'cancel-pow']) {
      test = client(mode);
      const controller = new AbortController();
      const running = collect(test.instance.chat({ prompt: 'x', signal: controller.signal }));
      const cancelled = assert.rejects(running, (error) => error.status === 499 && error.kind === 'cancelled');
      await test.fixture.waiting;
      controller.abort();
      await cancelled;
      if (mode === 'cancel-pow') {
        assert.deepStrictEqual(test.fixture.cleanups, ['session-cancel-pow']);
        await test.instance._deleteChain;
        assert.strictEqual(test.fixture.counts['/api/v0/chat_session/delete'], 1);
      } else assert.deepStrictEqual(test.fixture.cleanups, []);
      assert.strictEqual(test.fixture.counts['/api/v0/chat/completion'], undefined);
    }
    console.log('[PASS] 预先取消不创建会话、创建/PoW 中取消且已有会话实际删除');

    test = client('timeout-create', { idleTimeoutMs: 40 });
    await assert.rejects(collect(test.instance.chat({ prompt: 'x' })), (error) => error.status === 504);
    assert.strictEqual(test.fixture.counts['/api/v0/chat_session/create'], 1);
    console.log('[PASS] 会话 JSON 请求受 idleTimeoutMs 限制');
    console.log('上游协议测试全部通过');
  } finally {
    mock.closeAllConnections();
    await new Promise((resolve) => mock.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
