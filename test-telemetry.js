'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Telemetry } = require('./lib/telemetry');

const temporaryRoot = path.resolve(os.tmpdir());
const directories = [];

function directory() {
  const created = fs.mkdtempSync(path.join(temporaryRoot, 'ds2api-telemetry-'));
  directories.push(created);
  return created;
}

function request(id, extra = {}) {
  return {
    request_id: id,
    model: 'deepseek-v4.1-flash',
    stream: false,
    started_at: '2026-10-21T00:00:00.000Z',
    duration_ms: 120,
    status: 200,
    outcome: 'success',
    account_id: 'one',
    attempts: 1,
    ...extra,
  };
}

async function main() {
  const persistenceDirectory = directory();
  const clock = () => Date.parse('2026-10-21T00:00:01.000Z');
  const telemetry = new Telemetry({ directory: persistenceDirectory, now: clock });
  telemetry.recordAttempt({ account_id: 'one', outcome: 'failed', duration_ms: 30, error_kind: 'rate_limit' });
  telemetry.recordAttempt({ account_id: 'two', outcome: 'success', duration_ms: 90 });
  telemetry.recordRequest(request('retried', { account_id: 'two', attempts: 2 }));
  telemetry.recordRequest(request('failed', { status: 503, outcome: 'failed', duration_ms: 80 }));
  telemetry.recordRequest(request('cancelled', { status: 499, outcome: 'cancelled', duration_ms: 100 }));
  telemetry.recordAttempt({ account_id: 'two', outcome: 'cancelled', duration_ms: 40 });

  const stats = telemetry.stats();
  assert.strictEqual(stats.requests.total, 3);
  assert.strictEqual(stats.requests.success, 1);
  assert.strictEqual(stats.requests.failed, 1);
  assert.strictEqual(stats.requests.cancelled, 1);
  assert.strictEqual(stats.requests.success_rate, 0.5, '取消应独立计数，不计入成功率分母');
  assert.strictEqual(stats.requests.average_duration_ms, 100);
  assert.strictEqual(stats.attempts.total, 3);
  assert.strictEqual(stats.accounts.one.failed, 1);
  assert.strictEqual(stats.accounts.two.success, 1);
  assert.strictEqual(stats.accounts.two.cancelled, 1);
  assert.strictEqual(stats.accounts.two.success_rate, 1);
  assert.strictEqual(telemetry.getLogs().total, 3, '异步落盘前应可查看日志');
  stats.accounts.one.failed = 100;
  assert.strictEqual(telemetry.stats().accounts.one.failed, 1, '外部修改不能污染内部统计');
  await telemetry.close();

  const restored = new Telemetry({ directory: persistenceDirectory, now: clock });
  assert.strictEqual(restored.stats().requests.total, 3);
  assert.strictEqual(restored.stats().accounts.one.failed, 1);
  assert.strictEqual(restored.stats().requests.average_duration_ms, 100);
  assert.strictEqual(restored.getLogs().total, 3);
  restored.recordRequest(request('fourth', { duration_ms: 100 }));
  await restored.close();
  console.log('[PASS] 请求与尝试分开统计、取消口径、重启恢复及平均耗时');

  const logsDirectory = directory();
  const logs = new Telemetry({ directory: logsDirectory, now: clock });
  logs.recordRequest(request('first', {
    request_id: `first${String.fromCharCode(1)}`,
    model: `deepseek${String.fromCharCode(0)}-v4.1-flash`,
    token: 'TOKEN_SECRET', password: 'PASSWORD_SECRET', body: 'BODY_SECRET',
    prompt: 'PROMPT_SECRET', response: 'RESPONSE_SECRET', error: 'UPSTREAM_SECRET',
    error_kind: 'TOKEN_SECRET',
  }));
  logs.recordRequest(request('second', { account_id: 'two', outcome: 'failed', status: 429 }));
  logs.recordRequest(request('third', { account_id: 'one', outcome: 'failed', status: 401 }));
  const paged = logs.getLogs({ limit: 1, offset: 1 });
  assert.strictEqual(paged.total, 3);
  assert.strictEqual(paged.data[0].request_id, 'second');
  assert.deepStrictEqual(logs.getLogs({ account_id: 'one' }).data.map((entry) => entry.request_id), ['third', 'first']);
  assert.deepStrictEqual(logs.getLogs({ outcome: 'failed' }).data.map((entry) => entry.request_id), ['third', 'second']);
  assert.strictEqual(logs.getLogs({ limit: 1000 }).limit, 200);
  assert.strictEqual(logs.getLogs({ offset: -1 }).offset, 0);
  for (const invalid of [Infinity, -Infinity, NaN, 'Infinity', '1e999', 'invalid']) {
    const page = logs.getLogs({ limit: invalid, offset: invalid });
    assert.strictEqual(page.limit, 50);
    assert.strictEqual(page.offset, 0);
    assert.strictEqual(page.data.length, 3);
  }
  assert.strictEqual(logs.getLogs({ limit: 0 }).limit, 1);
  assert.strictEqual(logs.getLogs({ offset: 1e308 }).offset, Number.MAX_SAFE_INTEGER);
  const copy = logs.getLogs().data[0];
  copy.request_id = 'changed';
  assert.strictEqual(logs.getLogs().data[0].request_id, 'third');
  await logs.close();
  const logContents = fs.readFileSync(path.join(logsDirectory, 'requests.jsonl'), 'utf8');
  const physicalLines = logContents.split(String.fromCharCode(10)).filter(Boolean);
  assert.strictEqual(physicalLines.length, 3, 'JSONL 必须是三条真实换行分隔的记录');
  const parsedPhysicalLines = physicalLines.map((line) => JSON.parse(line));
  assert.strictEqual(parsedPhysicalLines[0].request_id, 'first', '控制字符过滤必须使用真正的字符范围');
  assert.strictEqual(parsedPhysicalLines[0].model, 'deepseek-v4.1-flash');
  assert.ok(!logContents.includes(String.fromCharCode(0)) && !logContents.includes(String.fromCharCode(1)));
  for (const secret of ['TOKEN_SECRET', 'PASSWORD_SECRET', 'BODY_SECRET', 'PROMPT_SECRET', 'RESPONSE_SECRET', 'UPSTREAM_SECRET']) {
    assert.ok(!logContents.includes(secret), `日志泄露 ${secret}`);
  }
  assert.strictEqual(JSON.parse(logContents.split('\n')[0]).error_kind, 'unknown');
  console.log('[PASS] 请求日志分页、过滤、不可变快照及白名单脱敏');

  const rotationDirectory = directory();
  const rotated = new Telemetry({ directory: rotationDirectory, maxLogBytes: 700, retentionFiles: 2, now: clock });
  for (let index = 0; index < 12; index++) {
    rotated.recordRequest(request(`rotation-${index}`));
    rotated.recordAttempt({ account_id: 'one', outcome: 'success', duration_ms: 1 });
  }
  await rotated.flush();
  assert.ok(fs.existsSync(path.join(rotationDirectory, 'requests.jsonl.1')));
  assert.ok(!fs.existsSync(path.join(rotationDirectory, 'requests.jsonl.2')));
  assert.ok(rotated.getLogs().total < 12);
  assert.strictEqual(rotated.getLogs().data[0].request_id, 'rotation-11');
  const retained = rotated.getLogs().data.map((entry) => entry.request_id);
  assert.strictEqual(rotated.stats().requests.total, 12, '轮转不能丢失累计统计');
  await rotated.close();
  const rotationRestored = new Telemetry({ directory: rotationDirectory, maxLogBytes: 700, retentionFiles: 2, now: clock });
  assert.deepStrictEqual(rotationRestored.getLogs().data.map((entry) => entry.request_id), retained);
  assert.strictEqual(rotationRestored.stats().requests.total, 12);
  assert.strictEqual(rotationRestored.stats().accounts.one.total, 12);
  await rotationRestored.close();
  console.log('[PASS] 日志大小轮转和保留数量、轮转后累计统计及日志恢复');

  const retentionDirectory = directory();
  const fiveFiles = new Telemetry({ directory: retentionDirectory, maxLogBytes: 400, retentionFiles: 5, now: clock });
  for (let index = 0; index < 8; index++) fiveFiles.recordRequest(request(`retention-${index}`));
  await fiveFiles.close();
  assert.ok(fs.existsSync(path.join(retentionDirectory, 'requests.jsonl.4')));
  fs.writeFileSync(path.join(retentionDirectory, 'requests.jsonl.4.backup'), 'must keep');
  fs.mkdirSync(path.join(retentionDirectory, 'requests.jsonl.99'));
  const reduced = new Telemetry({ directory: retentionDirectory, maxLogBytes: 400, retentionFiles: 1, now: clock });
  assert.ok(!fs.existsSync(path.join(retentionDirectory, 'requests.jsonl.1')));
  assert.ok(!fs.existsSync(path.join(retentionDirectory, 'requests.jsonl.4')));
  assert.ok(fs.existsSync(path.join(retentionDirectory, 'requests.jsonl.4.backup')));
  assert.ok(fs.statSync(path.join(retentionDirectory, 'requests.jsonl.99')).isDirectory());
  assert.strictEqual(reduced.stats().requests.total, 8);
  await reduced.close();
  console.log('[PASS] 缩小保留数量立即清理旧轮转文件，保留无关文件和目录');

  const oneFileDirectory = directory();
  const oneFile = new Telemetry({ directory: oneFileDirectory, maxLogBytes: 400, retentionFiles: 1, now: clock });
  for (let index = 0; index < 4; index++) oneFile.recordRequest(request(`single-${index}`));
  await oneFile.close();
  assert.strictEqual(fs.readdirSync(oneFileDirectory).filter((name) => name.startsWith('requests')).length, 1);
  assert.deepStrictEqual(oneFile.getLogs().data.map((entry) => entry.request_id), ['single-3']);
  assert.strictEqual(oneFile.recordRequest(request('closed')), false);
  console.log('[PASS] 单文件保留和关闭后停止接收记录');

  const faultyDirectory = directory();
  const blocker = path.join(faultyDirectory, 'file-instead-of-directory');
  fs.writeFileSync(blocker, 'blocker');
  const faulty = new Telemetry({ directory: blocker, now: clock });
  faulty.recordRequest(request('retry-after-disk-error'));
  await faulty.flush();
  assert.ok(faulty.stats().persistence_error);
  assert.strictEqual(faulty.stats().requests.total, 1);
  assert.strictEqual(faulty.getLogs().total, 1);
  fs.unlinkSync(blocker);
  await faulty.flush();
  assert.strictEqual(faulty.stats().persistence_error, null);
  await faulty.close();
  const recovered = new Telemetry({ directory: blocker, now: clock });
  assert.strictEqual(recovered.stats().requests.total, 1);
  assert.strictEqual(recovered.getLogs().total, 1);
  await recovered.close();
  console.log('[PASS] 磁盘错误不中断请求、可见错误码及恢复后重试落盘');

  const boundedDirectory = directory();
  const boundedBlocker = path.join(boundedDirectory, 'blocked');
  fs.writeFileSync(boundedBlocker, 'blocker');
  const boundedFailure = new Telemetry({ directory: boundedBlocker, maxBufferedLogs: 3, now: clock });
  for (let index = 0; index < 20; index++) boundedFailure.recordRequest(request(`bounded-${index}`));
  await boundedFailure.flush();
  assert.strictEqual(boundedFailure._pendingLogs.length, 3);
  assert.strictEqual(boundedFailure.getLogs().total, 3);
  assert.strictEqual(boundedFailure.stats().requests.total, 20);
  assert.strictEqual(boundedFailure.stats().dropped_logs, 17);
  fs.unlinkSync(boundedBlocker);
  await boundedFailure.close();
  const boundedRecovered = new Telemetry({ directory: boundedBlocker, maxBufferedLogs: 3, now: clock });
  assert.strictEqual(boundedRecovered.stats().requests.total, 20);
  assert.strictEqual(boundedRecovered.stats().dropped_logs, 17);
  assert.strictEqual(boundedRecovered.stats().logging_warning, 'logs_dropped');
  assert.strictEqual(boundedRecovered.getLogs().total, 3);
  await boundedRecovered.close();
  console.log('[PASS] 长期磁盘故障时日志队列和缓存有界，统计及丢弃计数持久化');

  const cacheDirectory = directory();
  const cappedCache = new Telemetry({ directory: cacheDirectory, maxLogBytes: 700, retentionFiles: 2, maxBufferedLogs: 3, now: clock });
  for (let index = 0; index < 12; index++) {
    cappedCache.recordRequest(request(`cache-${index}`));
    await cappedCache.flush();
  }
  const diskIds = [1, 0].flatMap((index) => {
    const filename = path.join(cacheDirectory, index ? `requests.jsonl.${index}` : 'requests.jsonl');
    return fs.readFileSync(filename, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((line) => JSON.parse(line).request_id);
  });
  const expectedRecent = diskIds.slice(-3).reverse();
  assert.deepStrictEqual(cappedCache.getLogs().data.map((entry) => entry.request_id), expectedRecent);
  assert.strictEqual(cappedCache.stats().dropped_logs, 0);
  assert.strictEqual(cappedCache.getLogs().truncated, true);
  await cappedCache.close();
  const cacheRestored = new Telemetry({ directory: cacheDirectory, maxLogBytes: 700, retentionFiles: 2, maxBufferedLogs: 3, now: clock });
  assert.deepStrictEqual(cacheRestored.getLogs().data.map((entry) => entry.request_id), expectedRecent);
  assert.strictEqual(cacheRestored.stats().requests.total, 12);
  await cacheRestored.close();
  console.log('[PASS] 可见日志缓存裁剪、磁盘轮转和重启索引保持一致');

  const truncatedDirectory = directory();
  fs.writeFileSync(path.join(truncatedDirectory, 'requests.jsonl'), '{"request_id":"partial');
  const afterTruncation = new Telemetry({ directory: truncatedDirectory, now: clock });
  afterTruncation.recordRequest(request('complete-after-truncation'));
  await afterTruncation.close();
  const truncationRestored = new Telemetry({ directory: truncatedDirectory, now: clock });
  assert.deepStrictEqual(truncationRestored.getLogs().data.map((entry) => entry.request_id), ['complete-after-truncation']);
  await truncationRestored.close();
  console.log('[PASS] 崩溃遗留半行不会吞掉后续完整日志');

  const partialDirectory = directory();
  const partialWrite = new Telemetry({ directory: partialDirectory, now: clock });
  const originalAppend = fs.promises.appendFile;
  let firstAppend = true;
  try {
    fs.promises.appendFile = async function (filename, contents, options) {
      if (firstAppend) {
        firstAppend = false;
        await originalAppend.call(this, filename, contents.slice(0, 30), options);
        throw Object.assign(new Error('partial append'), { code: 'ENOSPC' });
      }
      return originalAppend.call(this, filename, contents, options);
    };
    partialWrite.recordRequest(request('retry-partial-append'));
    await partialWrite.flush();
    assert.strictEqual(partialWrite.stats().persistence_error, 'ENOSPC');
    await partialWrite.flush();
    assert.strictEqual(partialWrite.stats().persistence_error, null);
  } finally {
    fs.promises.appendFile = originalAppend;
    await partialWrite.close();
  }
  const partialRestored = new Telemetry({ directory: partialDirectory, now: clock });
  assert.strictEqual(partialRestored.stats().requests.total, 1);
  assert.deepStrictEqual(partialRestored.getLogs().data.map((entry) => entry.request_id), ['retry-partial-append']);
  await partialRestored.close();
  console.log('[PASS] ENOSPC 半行写入失败后重试，完整日志仍可恢复');

  console.log('Telemetry 自测全部通过 ✔');
}

main().catch((error) => {
  console.error('[FAIL]', error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  for (const created of directories) {
    const absolute = path.resolve(created);
    if (path.dirname(absolute) !== temporaryRoot || !path.basename(absolute).startsWith('ds2api-telemetry-')) {
      throw new Error('拒绝清理不属于本测试的目录');
    }
    fs.rmSync(absolute, { recursive: true, force: true });
  }
});
