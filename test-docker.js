'use strict';
// 验证 Docker 入口的首次配置、凭证保留和日志；无需 Docker 或外部网络。
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { once } = require('events');
const { initialize } = require('./docker/entrypoint');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ds2api-docker-test-'));
const entrypoint = path.join(__dirname, 'docker', 'entrypoint.js');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child = null;
let output = '';

function config(name, value) {
  const file = path.join(directory, name, 'config.json');
  if (value !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  }
  return file;
}

function environment(file, extra = {}) {
  return {
    ...process.env, DS_CONFIG_PATH: file, DS_TOKEN: '', DS_API_KEY: '', DS_ADMIN_KEY: '',
    DS_HOST: '127.0.0.1', DS_BASE_URL: 'http://127.0.0.1:1',
    DS_DATA_DIR: path.join(path.dirname(file), 'state'),
    DS_PID_PATH: path.join(path.dirname(file), 'server.pid'), ...extra,
  };
}

function run(file, args, extra = {}) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    env: environment(file, extra), encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
}

async function freePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const fresh = config('fresh');
  const first = initialize(fresh);
  assert.match(first.api_key, /^sk-[a-f0-9]{64}$/);
  assert.match(first.admin_key, /^admin-[a-f0-9]{64}$/);
  assert.notStrictEqual(first.api_key.slice(3), first.admin_key.slice(6));
  assert.deepStrictEqual(initialize(fresh), first);
  const other = initialize(config('other'));
  assert.notStrictEqual(other.api_key, first.api_key);
  assert.notStrictEqual(other.admin_key, first.admin_key);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(fresh).mode & 0o777, 0o600);
  console.log('[PASS] 首次生成独立随机密钥，重复初始化保留密钥与配置权限');

  const existing = {
    api_key: 'existing-api-key', admin_key: 'existing-admin-key',
    accounts: [{ id: 'work', token: 'existing-account-token', enabled: false, qps: 2, rpm: 30 }],
    search_enabled: true,
  };
  const existingPath = config('existing', existing);
  const bytes = fs.readFileSync(existingPath, 'utf8');
  assert.deepStrictEqual(initialize(existingPath), existing);
  assert.strictEqual(fs.readFileSync(existingPath, 'utf8'), bytes);
  const legacyPath = config('legacy', { api_key: 'legacy-api-key', token: 'legacy-token' });
  const legacy = initialize(legacyPath);
  assert.strictEqual(legacy.api_key, 'legacy-api-key');
  assert.strictEqual(legacy.token, 'legacy-token');
  assert.strictEqual(legacy.accounts, undefined);
  assert.match(legacy.admin_key, /^admin-[a-f0-9]{64}$/);
  const blankPath = config('blank', { api_key: ' ', admin_key: '\t', accounts: [] });
  const blank = initialize(blankPath);
  assert.match(blank.api_key, /^sk-[a-f0-9]{64}$/);
  assert.match(blank.admin_key, /^admin-[a-f0-9]{64}$/);
  assert.deepStrictEqual(blank.accounts, []);
  console.log('[PASS] 保留现有账号、旧版 Token 和非空密钥，仅补齐缺少或空白密钥');

  for (const [name, value] of [
    ['invalid-key', { api_key: { secret: 'hidden-key' }, accounts: [] }],
    ['invalid-accounts', { accounts: {} }],
    ['duplicate-accounts', { accounts: [{ id: 'same' }, { id: 'same' }] }],
  ]) {
    const file = config(name, value);
    const original = fs.readFileSync(file, 'utf8');
    assert.throws(() => initialize(file));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
  }
  console.log('[PASS] 无效配置初始化失败并保留原文件');

  let result = run(existingPath, ['--show-credentials']);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(existing.api_key));
  assert.ok(result.stdout.includes(existing.admin_key));
  assert.ok(!result.stdout.includes(existing.accounts[0].token));
  result = run(existingPath, ['--show-credentials'], {
    DS_API_KEY: 'override-api-key', DS_ADMIN_KEY: 'override-admin-key',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('override-api-key'));
  assert.ok(result.stdout.includes('override-admin-key'));
  assert.ok(!result.stdout.includes(existing.api_key));
  assert.ok(!result.stdout.includes(existing.admin_key));
  assert.deepStrictEqual(read(existingPath), existing);
  const missing = config('missing');
  result = run(missing, ['--show-credentials']);
  assert.strictEqual(result.status, 1);
  assert.ok(!fs.existsSync(missing));
  result = run(existingPath, ['--unknown']);
  assert.strictEqual(result.status, 2);
  console.log('[PASS] 显式查询凭证遵循环境变量优先级，查询不创建配置或修改密钥');

  const malformed = config('malformed', {});
  const broken = '{"api_key":"private-json-fragment","accounts":[';
  fs.writeFileSync(malformed, broken);
  for (const args of [[], ['--show-credentials']]) {
    result = run(malformed, args);
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('SyntaxError'));
    assert.ok(!(result.stdout + result.stderr).includes('private-json-fragment'));
    assert.strictEqual(fs.readFileSync(malformed, 'utf8'), broken);
  }
  console.log('[PASS] JSON 解析失败的 CLI 错误不泄露凭证片段');

  const port = await freePort();
  const runtimePath = config('runtime');
  child = spawn(process.execPath, [entrypoint], {
    env: environment(runtimePath, { DS_PORT: String(port) }), windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  child.stdout.setEncoding('utf8').on('data', (text) => { output += text; });
  child.stderr.setEncoding('utf8').on('data', (text) => { output += text; });
  const baseUrl = 'http://127.0.0.1:' + port;
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const response = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(300) });
      const body = await response.json();
      if (response.ok && body.ok === true) {
        assert.strictEqual(body.token_configured, false);
        healthy = true;
        break;
      }
    } catch { /* 启动前拒绝连接，继续短暂等待。 */ }
    await sleep(50);
  }
  assert.ok(healthy, '容器入口未启动健康服务：' + output);
  const runtime = read(runtimePath);
  let response = await fetch(baseUrl + '/v1/models');
  assert.strictEqual(response.status, 401);
  await response.arrayBuffer();
  response = await fetch(baseUrl + '/v1/models', {
    headers: { authorization: 'Bearer ' + runtime.api_key },
  });
  assert.strictEqual(response.status, 200);
  await response.arrayBuffer();
  response = await fetch(baseUrl + '/admin/api/status', {
    headers: { authorization: 'Bearer ' + runtime.admin_key },
  });
  assert.strictEqual(response.status, 200);
  await response.arrayBuffer();
  assert.ok(!output.includes(runtime.api_key));
  assert.ok(!output.includes(runtime.admin_key));
  child.kill('SIGTERM');
  const [code] = await exited;
  child = null;
  if (process.platform !== 'win32') assert.strictEqual(code, 0);
  assert.deepStrictEqual(read(runtimePath), runtime);
  console.log('[PASS] 容器入口空号池健康启动、双密钥鉴权、无凭证启动日志及终止');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('无效测试目录');
  fs.rmSync(directory, { recursive: true, force: true });
});
