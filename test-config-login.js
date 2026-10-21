'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { ConfigStore } = require('./lib/config');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ds2api-login-test-'));
const configPath = path.join(directory, 'config.json');
const secret = 'private-test-token';
function run(args) {
  return spawnSync(process.execPath, [path.join(__dirname, 'login.js'), ...args], {
    env: { ...process.env, DS_CONFIG_PATH: configPath, DS_TOKEN: '' },
    encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
}
try {
  const store = new ConfigStore(configPath);
  let result = run(['--token', secret]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(store.read().token, secret);
  result = run(['--show']);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(secret));
  result = run(['--account', 'work', '--token', 'work-secret']);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(store.read().token, '');
  assert.deepStrictEqual(store.accounts().map((account) => account.id), ['default', 'work']);
  const accounts = store.accounts();
  accounts[1].token_expires_at = '2020-01-01T00:00:00Z';
  store.saveAccounts(accounts);
  result = run(['--token', 'updated-secret', '--account', 'work']);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(store.accounts()[1].token, 'updated-secret');
  assert.strictEqual(store.accounts()[1].token_expires_at, null);
  result = run(['--token', 'ambiguous-secret']);
  assert.strictEqual(result.status, 1);
  assert.strictEqual(store.accounts()[1].token, 'updated-secret');
  result = run(['--show']);
  assert.strictEqual(result.status, 0, result.stderr);
  for (const token of [secret, 'work-secret', 'updated-secret']) assert.ok(!result.stdout.includes(token));
  assert.ok(!fs.readdirSync(directory).some((name) => name.endsWith('.tmp')));
  console.log('[PASS] 单账号兼容、迁移、多账号凭证更新、过期清理与 CLI 脱敏');
} finally {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('无效测试目录');
  fs.rmSync(directory, { recursive: true, force: true });
}
