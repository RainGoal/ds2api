'use strict';
// 真实代理 + mock 上游；配置、PID、统计全部写入独立临时目录。
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { once } = require('events');

const PROJECT = __dirname;
const CLIENT_KEY = 'pool-test-client-key';
const ADMIN_KEY = 'pool-test-admin-key';
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seen = [];
const concurrent = new Map();
const maximumConcurrent = new Map();
const secrets = [CLIENT_KEY, ADMIN_KEY, 'bad-secret', 'limited-secret', 'ok-secret'];
let child = null;
let childOutput = '';
let workDirectory = null;
let baseUrl = '';
let mock = null;

function envelope(data = {}) {
  return JSON.stringify({ code: 0, data: { biz_code: 0, biz_msg: '', biz_data: data } });
}

function failure(res, status, message, code) {
  res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '2' });
  res.end(JSON.stringify({ code: 0, data: { biz_code: code, biz_msg: message } }));
}

function fragment(content) {
  return `data: ${JSON.stringify({ p: 'response/fragments', o: 'APPEND', v: [{ id: 1, type: 'RESPONSE', content }] })}\n\n`;
}

function createMock() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const url = req.url;
      seen.push({ url, token, at: Date.now() });
      if (url === '/api/v0/chat_session/create') {
        if (token === 'bad-secret') return failure(res, 401, 'token expired', 40002);
        if (token === 'opaque-secret') return failure(res, 401, 'private upstream response', { private: 'opaque-secret' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(envelope({ chat_session: { id: `test-session-${seen.length}` } }));
        return;
      }
      if (url === '/api/v0/chat/create_pow_challenge') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(envelope({ challenge: KNOWN_CHALLENGE }));
        return;
      }
      if (url === '/api/v0/chat_session/delete') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(envelope());
        return;
      }
      if (url !== '/api/v0/chat/completion') {
        res.writeHead(404);
        res.end();
        return;
      }
      const payload = JSON.parse(body);
      seen[seen.length - 1].prompt = payload.prompt;
      const pow = JSON.parse(Buffer.from(req.headers['x-ds-pow-response'], 'base64').toString('utf8'));
      assert.strictEqual(pow.answer, 58595);
      if (token === 'limited-secret') return failure(res, 429, 'message sent too frequently', 429);
      const active = (concurrent.get(token) || 0) + 1;
      concurrent.set(token, active);
      maximumConcurrent.set(token, Math.max(maximumConcurrent.get(token) || 0, active));
      let finished = false;
      let interval = null;
      let timeout = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(interval);
        clearTimeout(timeout);
        concurrent.set(token, (concurrent.get(token) || 1) - 1);
      };
      res.on('close', finish);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n');
      if (payload.prompt === 'SSE_FAIL_AFTER_OUTPUT') {
        res.write(fragment('partial-answer'));
        timeout = setTimeout(() => {
          res.end('event: toast\ndata: {"type":"error","content":"message sent too frequently"}\n\n');
        }, 30);
        return;
      }
      if (payload.prompt === 'CANCEL_ME') {
        res.write(fragment('waiting-for-cancellation'));
        interval = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 50);
        return;
      }
      const complete = () => {
        res.write(fragment('mock-success'));
        res.end('data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\nevent: close\ndata: {}\n\n');
      };
      if (payload.prompt === 'HOLD_CONCURRENCY') timeout = setTimeout(complete, 450);
      else complete();
    });
  });
}

async function waitFor(predicate, message, timeout = 5000) {
  const until = Date.now() + timeout;
  let lastError;
  while (Date.now() < until) {
    try { if (await predicate()) return; }
    catch (error) { lastError = error; }
    await sleep(25);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function availablePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer(port) {
  childOutput = '';
  child = spawn(process.execPath, [path.join(PROJECT, 'server.js')], {
    cwd: PROJECT,
    env: {
      ...process.env,
      DS_CONFIG_PATH: path.join(workDirectory, 'config.json'),
      DS_DATA_DIR: path.join(workDirectory, 'data'),
      DS_PID_PATH: path.join(workDirectory, 'server.pid'),
      DS_HOST: '127.0.0.1',
      DS_PORT: String(port),
      DS_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
      DS_API_KEY: CLIENT_KEY,
      DS_ADMIN_KEY: ADMIN_KEY,
      DS_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-12000); });
  child.stderr.on('data', (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-12000); });
  baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`代理提前退出 ${child.exitCode}`);
    return (await fetch(`${baseUrl}/health`)).ok;
  }, '代理未能启动');
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const running = child;
  const exited = once(running, 'exit');
  let timeout;
  running.kill();
  await Promise.race([
    exited,
    new Promise((resolve) => {
      timeout = setTimeout(() => {
        if (running.exitCode === null) running.kill('SIGKILL');
        resolve();
      }, 3000);
    }),
  ]);
  clearTimeout(timeout);
  if (running.exitCode === null) await exited;
  child = null;
}

async function call(url, { key = ADMIN_KEY, method = 'GET', body, signal } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal || AbortSignal.timeout(10000),
  });
  return response;
}

async function admin(url, method = 'GET', body) {
  const response = await call(`/admin/api${url}`, { method, body });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${url} 返回 ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const status = () => admin('/status');
const stats = () => admin('/stats');
const patch = (id, changes) => admin(`/accounts/${encodeURIComponent(id)}`, 'PATCH', changes);
const remove = (id) => admin(`/accounts/${encodeURIComponent(id)}`, 'DELETE');

async function createAccount(id, extra = {}) {
  const token = `${id}-secret`;
  secrets.push(token);
  return admin('/accounts', 'POST', { id, name: id, token, qps: 100, rpm: 100, max_concurrent: 1, ...extra });
}

async function isolate(id) {
  const snapshot = await status();
  for (const account of snapshot.pool.accounts) await patch(account.id, { enabled: account.id === id });
}

async function chat(prompt, options = {}) {
  const response = await call('/v1/chat/completions', {
    key: CLIENT_KEY,
    method: 'POST',
    body: { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: prompt }], stream: false, ...options },
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), headers: response.headers };
}

async function main() {
  workDirectory = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'ds2api-server-pool-'));
  mock = createMock();
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(workDirectory, 'config.json'), JSON.stringify({
    host: '127.0.0.1', api_key: CLIENT_KEY, admin_key: ADMIN_KEY,
    risk_headers: false, idle_timeout_ms: 4000,
    pool_settings: {
      qps: 100, rpm: 100, max_concurrent: 1, cooldown_seconds: 2,
      max_cooldown_seconds: 10, queue_timeout_ms: 1400, max_pending: 1, max_attempts: 3,
    },
    accounts: [
      { id: 'bad', name: '过期账号', token: 'bad-secret' },
      { id: 'limited', name: '限流账号', token: 'limited-secret' },
      { id: 'ok', name: '正常账号', token: 'ok-secret' },
    ],
  }, null, 2));
  const port = await availablePort();
  await startServer(port);

  assert.strictEqual((await call('/admin/api/status', { key: CLIENT_KEY })).status, 401, '调用 Key 不能访问管理接口');
  assert.strictEqual((await call('/admin/api/status', { key: 'wrong' })).status, 401);
  const page = await fetch(`${baseUrl}/admin`);
  assert.strictEqual(page.status, 200);
  assert.ok((await page.text()).includes('<html'), '应提供网页管理台');
  console.log('[PASS] 管理台可访问、管理密钥与调用密钥隔离');

  const first = await chat('DO_NOT_LOG_PROMPT');
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.choices[0].message.content, 'mock-success');
  const firstStats = await stats();
  assert.strictEqual(firstStats.requests.total, 1);
  assert.strictEqual(firstStats.requests.success, 1);
  assert.strictEqual(firstStats.attempts.total, 3);
  assert.strictEqual(firstStats.attempts.failed, 2);
  const firstPool = (await status()).pool;
  assert.strictEqual(firstPool.accounts.find((account) => account.id === 'bad').status, 'invalid');
  assert.strictEqual(firstPool.accounts.find((account) => account.id === 'limited').status, 'cooldown');
  const firstPublic = JSON.stringify({ pool: firstPool, logs: await admin('/logs') });
  for (const secret of secrets) assert.ok(!firstPublic.includes(secret), '管理接口不能泄露凭证');
  assert.ok(!firstPublic.includes('DO_NOT_LOG_PROMPT'), '日志不能包含提示词');
  console.log('[PASS] 401 停用、429 冷却、首输出前换号、请求与尝试分开计数');

  await createAccount('extra');
  await patch('extra', { enabled: false, name: '临时账号', qps: 2, rpm: 3 });
  const extra = (await status()).pool.accounts.find((account) => account.id === 'extra');
  assert.strictEqual(extra.status, 'disabled');
  assert.strictEqual(extra.qps, 2);
  assert.strictEqual(extra.rpm, 3);
  await patch('bad', { token: 'recovered-secret', enabled: true });
  secrets.push('recovered-secret');
  assert.strictEqual((await status()).pool.accounts.find((account) => account.id === 'bad').status, 'available');
  await remove('limited');
  await remove('extra');
  await isolate('bad');
  const hot = await chat('hot-token-check');
  assert.strictEqual(hot.status, 200);
  assert.ok(seen.some((entry) => entry.prompt === 'hot-token-check' && entry.token === 'recovered-secret'));
  const invalidLimit = await call('/admin/api/accounts/bad', { method: 'PATCH', body: { qps: 0 } });
  assert.strictEqual(invalidLimit.status, 400);
  assert.strictEqual((await status()).pool.accounts.find((account) => account.id === 'bad').qps, 100);
  console.log('[PASS] 账号增删改与凭证恢复即时生效、配置校验失败保持原状态');

  await patch('bad', { token_expires_at: '2020-01-01T00:00:00Z' });
  const imported = spawnSync(process.execPath, [path.join(PROJECT, 'login.js'), '--account', 'bad', '--token', 'cli-secret'], {
    env: { ...process.env, DS_CONFIG_PATH: path.join(workDirectory, 'config.json'), DS_TOKEN: '' },
    encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  assert.strictEqual(imported.status, 0, imported.stderr);
  await waitFor(async () => (await status()).pool.accounts.find((account) => account.id === 'bad').status === 'available',
    'CLI 更新凭证没有被运行中的服务加载');
  assert.strictEqual((await chat('cli-hot-token-check')).status, 200);
  assert.ok(seen.some((entry) => entry.prompt === 'cli-hot-token-check' && entry.token === 'cli-secret'));
  secrets.push('cli-secret');
  console.log('[PASS] CLI 更新凭证后自动热加载，无需重启');

  const duplicate = await call('/admin/api/accounts', { method: 'POST', body: { id: 'duplicate', token: 'cli-secret' } });
  assert.strictEqual(duplicate.status, 400, '同一凭证不能通过多个账号条目绕过限额');
  await createAccount('expired', { token_expires_at: '2020-01-01T00:00:00Z' });
  assert.strictEqual((await status()).pool.accounts.find((account) => account.id === 'expired').status, 'invalid');
  await patch('expired', { token: 'renewed-secret' });
  assert.strictEqual((await status()).pool.accounts.find((account) => account.id === 'expired').status, 'available');
  assert.strictEqual((await status()).pool.accounts.find((account) => account.id === 'expired').token_expires_at, null);
  await remove('expired');
  console.log('[PASS] 重复凭证拒绝、更新新 Token 后清理旧过期时间');

  await createAccount('opaque');
  await isolate('opaque');
  const opaque = await chat('opaque-error-code');
  assert.strictEqual(opaque.status, 401);
  assert.strictEqual(opaque.body.error.code, null);
  assert.ok(!JSON.stringify(opaque.body).includes('opaque-secret'), '不可信上游错误码不能泄露凭证');
  await remove('opaque');
  await patch('bad', { enabled: true });
  console.log('[PASS] 不可信上游错误文本与错误码脱敏');

  await patch('ok', { enabled: true });
  const beforeFailure = seen.filter((entry) => entry.url === '/api/v0/chat/completion').length;
  const failureResponse = await call('/v1/chat/completions', {
    key: CLIENT_KEY, method: 'POST',
    body: { stream: true, messages: [{ role: 'user', content: 'SSE_FAIL_AFTER_OUTPUT' }] },
  });
  assert.strictEqual(failureResponse.status, 200);
  const failureText = await failureResponse.text();
  assert.ok(failureText.includes('partial-answer') && failureText.includes('"error"'));
  assert.strictEqual(seen.filter((entry) => entry.url === '/api/v0/chat/completion').length - beforeFailure, 1, '已输出内容后不得换号拼接');
  const failedLogs = await admin('/logs?outcome=failed');
  assert.ok(failedLogs.data.some((entry) => entry.stream && entry.http_status === 200), 'SSE 错误应按失败记录，保留 HTTP 200');
  console.log('[PASS] 流式中途错误不换号、SSE 错误统计与日志正确');

  await createAccount('cancel');
  await isolate('cancel');
  const abort = new AbortController();
  const cancellable = await call('/v1/chat/completions', {
    key: CLIENT_KEY, method: 'POST', signal: abort.signal,
    body: { stream: true, messages: [{ role: 'user', content: 'CANCEL_ME' }] },
  });
  const reader = cancellable.body.getReader();
  await reader.read();
  abort.abort();
  await reader.cancel().catch(() => {});
  await waitFor(async () => {
    const snapshot = await status();
    return snapshot.pool.accounts.find((account) => account.id === 'cancel').in_flight === 0 && snapshot.statistics.requests.cancelled >= 1;
  }, '客户端取消后没有释放账号或记录取消');
  assert.strictEqual((await chat('after-cancel')).status, 200);
  console.log('[PASS] 客户端取消释放账号并单独计数，后续请求可继续使用');

  await createAccount('serial');
  await isolate('serial');
  const firstSerial = chat('HOLD_CONCURRENCY');
  await waitFor(() => (concurrent.get('serial-secret') || 0) === 1, '长请求没有开始');
  const secondSerial = chat('queued-behind-first');
  await waitFor(async () => (await status()).pool.summary.pending === 1, '请求未进入队列');
  const overflowStarted = Date.now();
  const overflow = await chat('queue-overflow');
  assert.ok([429, 503].includes(overflow.status), `队列满应拒绝请求，实际 ${overflow.status}`);
  assert.ok(Date.now() - overflowStarted < 350, '队列满应立即拒绝');
  assert.strictEqual((await firstSerial).status, 200);
  assert.strictEqual((await secondSerial).status, 200);
  assert.strictEqual(maximumConcurrent.get('serial-secret'), 1);
  console.log('[PASS] 单账号并发约束、排队、队列容量保护');

  await createAccount('qps', { qps: 1, rpm: 10 });
  await isolate('qps');
  assert.strictEqual((await chat('qps-first')).status, 200);
  const qpsWait = Date.now();
  assert.strictEqual((await chat('qps-second')).status, 200);
  assert.ok(Date.now() - qpsWait >= 850, 'QPS 限制应等待窗口释放');
  console.log('[PASS] 单账号 QPS 滑动窗口限制与等待调度');

  await createAccount('rpm', { qps: 10, rpm: 1 });
  await isolate('rpm');
  assert.strictEqual((await chat('rpm-first')).status, 200);
  const rpmWait = Date.now();
  const rpmBlocked = await chat('rpm-blocked');
  assert.ok([429, 503].includes(rpmBlocked.status), `RPM 窗口内应限流，实际 ${rpmBlocked.status}`);
  assert.ok(Date.now() - rpmWait >= 1100, '等待 RPM 窗口应受排队超时控制');
  assert.ok(rpmBlocked.body.error);
  assert.ok(!seen.some((entry) => entry.prompt === 'rpm-blocked'), '被本地 RPM 限制的请求不能触达上游');
  console.log('[PASS] 单账号 RPM 限制、等待超时与上游请求隔离');

  const allLogs = await admin('/logs?limit=200');
  const publicText = JSON.stringify({ status: await status(), logs: allLogs });
  for (const secret of secrets) assert.ok(!publicText.includes(secret), '管理数据泄露账号凭证');
  for (const prompt of ['DO_NOT_LOG_PROMPT', 'CANCEL_ME', 'SSE_FAIL_AFTER_OUTPUT']) assert.ok(!publicText.includes(prompt));
  const paged = await admin('/logs?limit=2&offset=1');
  assert.strictEqual(paged.data.length, 2);
  assert.strictEqual(paged.total, allLogs.total);
  const beforeRestart = await stats();
  await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(workDirectory, 'data', 'stats.json'), 'utf8')).requests.total === beforeRestart.requests.total;
    } catch { return false; }
  }, '统计尚未落盘');
  const physicalLogs = fs.readFileSync(path.join(workDirectory, 'data', 'requests.jsonl'), 'utf8').split(String.fromCharCode(10)).filter(Boolean);
  assert.ok(physicalLogs.length > 1);
  for (const line of physicalLogs) JSON.parse(line);
  await stopServer();
  await startServer(port);
  const restarted = await status();
  assert.strictEqual(restarted.statistics.requests.total, beforeRestart.requests.total);
  assert.strictEqual(restarted.statistics.attempts.total, beforeRestart.attempts.total);
  assert.ok(restarted.pool.accounts.some((account) => account.id === 'rpm' && account.rpm === 1));
  assert.ok(!restarted.pool.accounts.some((account) => account.id === 'limited'));
  console.log('[PASS] 日志脱敏分页、实际 JSONL 格式、账号与统计重启持久化');
  console.log('账号池全链路测试全部通过 ✔');
}

main().catch((error) => {
  console.error('[FAIL]', error.stack || error.message);
  if (childOutput) console.error(childOutput);
  process.exitCode = 1;
}).finally(async () => {
  await stopServer();
  if (mock) {
    if (mock.closeAllConnections) mock.closeAllConnections();
    await new Promise((resolve) => mock.close(resolve));
  }
  if (workDirectory) {
    const absolute = path.resolve(workDirectory);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('ds2api-server-pool-')) {
      throw new Error('拒绝清理不属于本测试的目录');
    }
    fs.rmSync(absolute, { recursive: true, force: true });
  }
});
