'use strict';
// 自测：PoW 求解器对实测抓包向量的已知答案校验
//
// 向量来自真实网页客户端抓包（服务端已接受过该 salt/expire_at/answer 组合）：
//   challenge = 168efa309e5a73033fc82dde4333bbc6515da440ef961574f73f99cbe7b397ad
//   prefix    = a40318e6b7af56bf27cf_1790959021012_
//   answer    = 58595        difficulty = 144000
const assert = require('assert');
const { solveChallenge, loadWasm, wasmSolve } = require('./lib/pow');
const { SseParser, StreamState } = require('./lib/dsweb');
const { parseToolCalls, holdIndex, renderCallsBlock } = require('./lib/tools');

function parseAll(text) {
  const parser = new SseParser();
  const frames = [...parser.drain(text)];
  return frames;
}

function runFrames(frames) {
  const state = new StreamState();
  const events = [];
  for (const f of frames) events.push(...state.handleFrame(f));
  events.push(state.finish());
  return { state, events };
}

async function main() {
  // 1. WASM 加载
  const wasm = await loadWasm();
  console.log('[PASS] WASM 求解器加载成功');

  // 2. 已知答案：必须求出 nonce=58595
  const t0 = Date.now();
  const answer = wasmSolve(wasm, '168efa309e5a73033fc82dde4333bbc6515da440ef961574f73f99cbe7b397ad', 'a40318e6b7af56bf27cf_1790959021012_', 144000);
  assert.strictEqual(answer, 58595, `已知答案不匹配: got ${answer}`);
  console.log(`[PASS] 已知答案求解 nonce=58595（${Date.now() - t0}ms）`);

  // 3. solveChallenge 端到端（含 x-ds-pow-response 头构造）
  const res = await solveChallenge({
    algorithm: 'DeepSeekHashV1',
    challenge: '168efa309e5a73033fc82dde4333bbc6515da440ef961574f73f99cbe7b397ad',
    salt: 'a40318e6b7af56bf27cf',
    signature: '68abc6d6d301b6d89a4075622ace2c909c6262860e813230bc519f78cd0aa159',
    difficulty: 144000,
    expire_at: 1790959021012,
    expire_after: 300000,
    target_path: '/api/v0/chat/completion',
  });
  const decoded = JSON.parse(Buffer.from(res.header, 'base64').toString('utf-8'));
  assert.strictEqual(decoded.answer, 58595);
  assert.strictEqual(decoded.algorithm, 'DeepSeekHashV1');
  assert.strictEqual(decoded.target_path, '/api/v0/chat/completion');
  assert.strictEqual(decoded.salt, 'a40318e6b7af56bf27cf');
  console.log(`[PASS] x-ds-pow-response 头构造正确（${res.tookMs}ms）`);

  // 4. SSE 帧解析（含心跳注释与多行 data）
  const frames = parseAll(
    ': keep-alive\n\n' +
      'event: ready\ndata: {"request_message_id":1}\n\n' +
      'data: {"v":1}\ndata: {"v":2}\n\n'
  );
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[0].event, 'ready');
  assert.strictEqual(frames[1].data, '{"v":1}\n{"v":2}');
  console.log('[PASS] SSE 帧解析');

  // 5. 补丁协议状态机（真实抓包帧序列）
  const modern = runFrames(
    parseAll(
      'event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"default"}\n\n' +
        'event: update_session\ndata: {"updated_at":1}\n\n' +
        'data: {"v":{"response":{"fragments":[{"id":2,"type":"THINK","content":"我们需要"}]}}}\n\n' +
        'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"回答"}\n\n' +
        'data: {"v":"用户"}\n\n' +
        'data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":0.6}\n\n' +
        'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"1"}]}\n\n' +
        'data: {"p":"response/fragments/-1/content","v":"+"}\n\n' +
        'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":74},{"p":"quasi_status","v":"FINISHED"}]}\n\n' +
        'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n' +
        'event: title\ndata: {"content":"1加1等于2"}\n\n' +
        'event: close\ndata: {"click_behavior":"none"}\n\n'
    )
  );
  const deltas = modern.events.filter((e) => e.kind === 'delta');
  assert.strictEqual(
    deltas.filter((d) => d.type === 'reasoning').map((d) => d.text).join(''),
    '我们需要回答用户'
  );
  assert.strictEqual(deltas.filter((d) => d.type === 'content').map((d) => d.text).join(''), '1+');
  const done = modern.events.find((e) => e.kind === 'done');
  assert.strictEqual(done.finishReason, 'stop');
  assert.strictEqual(done.usage, 74);
  console.log('[PASS] 补丁协议（fragments 版）');

  // 6. 旧版协议（response/content + response/thinking_content）
  const legacy = runFrames(
    parseAll(
      'data: {"p":"response/thinking_content","o":"APPEND","v":"思考中"}\n\n' +
        'data: {"p":"response/content","o":"APPEND","v":"正文"}\n\n' +
        'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n' +
        'event: close\ndata: {}\n\n'
    )
  );
  assert.strictEqual(legacy.events.filter((e) => e.kind === 'delta' && e.type === 'reasoning').map((d) => d.text).join(''), '思考中');
  assert.strictEqual(legacy.events.filter((e) => e.kind === 'delta' && e.type === 'content').map((d) => d.text).join(''), '正文');
  console.log('[PASS] 补丁协议（旧版）');

  // 7. toast 错误
  assert.throws(
    () =>
      runFrames(parseAll('event: toast\ndata: {"type":"error","content":"message sent too frequently"}\n\n')),
    /frequently/
  );
  console.log('[PASS] toast 错误识别');

  // 8. 工具调用解析：DSML 标记 → tool_calls（含并行调用与非字符串参数）
  const callText =
    '我先看下目录。\n' +
    '<｜｜DSML｜｜ calls>\n' +
    '<｜｜DSML｜｜ invoke name="Bash">\n' +
    '<｜｜DSML｜｜ parameter name="command" string="true">ls -la</｜｜DSML｜｜ parameter>\n' +
    '<｜｜DSML｜｜ parameter name="timeout" >60</｜｜DSML｜｜ parameter>\n' +
    '</｜｜DSML｜｜ invoke>\n' +
    '<｜｜DSML｜｜ invoke name="Read">\n' +
    '<｜｜DSML｜｜ parameter name="file_path" string="true">D:\\a\\b.txt</｜｜DSML｜｜ parameter>\n' +
    '</｜｜DSML｜｜ invoke>\n' +
    '</｜｜DSML｜｜ calls>';
  const parsed = parseToolCalls(callText);
  assert.strictEqual(parsed.text, '我先看下目录。');
  assert.strictEqual(parsed.calls.length, 2);
  assert.strictEqual(parsed.calls[0].name, 'Bash');
  assert.deepStrictEqual(JSON.parse(parsed.calls[0].arguments), { command: 'ls -la', timeout: 60 });
  assert.strictEqual(parsed.calls[1].name, 'Read');
  assert.deepStrictEqual(JSON.parse(parsed.calls[1].arguments), { file_path: 'D:\\a\\b.txt' });
  // 无调用时正文原样返回
  assert.strictEqual(parseToolCalls('普通回答 1+1=2').text, '普通回答 1+1=2');
  console.log('[PASS] 工具调用解析（DSML → tool_calls）');

  // 9. 闭合标签另一种写法 <｜｜DSML｜｜ /invoke> 与未闭合截断抢救
  const alt = parseToolCalls(
    '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="Bash"><｜｜DSML｜｜ parameter name="c" string="true">x<｜｜DSML｜｜ /parameter><｜｜DSML｜｜ /invoke><｜｜DSML｜｜ /calls>'
  );
  assert.strictEqual(alt.calls.length, 1);
  assert.deepStrictEqual(JSON.parse(alt.calls[0].arguments), { c: 'x' });
  const truncated = parseToolCalls(
    '前文<｜｜DSML｜｜ invoke name="Bash"><｜｜DSML｜｜ parameter name="command" string="true">ls -la'
  );
  assert.strictEqual(truncated.text, '前文');
  assert.strictEqual(truncated.calls.length, 1);
  assert.deepStrictEqual(JSON.parse(truncated.calls[0].arguments), { command: 'ls -la' });
  console.log('[PASS] 工具调用解析（兼容闭合写法 / 截断抢救）');

  // 10. holdIndex：标记定形前扣住正文，防止 DSML 泄漏成 content
  assert.strictEqual(holdIndex('你好'), 2);
  assert.strictEqual(holdIndex('你好<'), 2);
  assert.strictEqual(holdIndex('你好<｜｜DSML'), 2);
  assert.strictEqual(holdIndex('你好<｜｜DSML｜｜ invoke'), 2);
  assert.strictEqual(holdIndex('a < b > c'), 9);
  console.log('[PASS] 流式 holdIndex 扣住工具调用标记');

  // 11. tool_calls 渲染回 DSML 往返一致（多轮历史回填）
  const block = renderCallsBlock([
    { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls","n":2}' } },
  ]);
  const rt = parseToolCalls(block);
  assert.strictEqual(rt.text, '');
  assert.strictEqual(rt.calls.length, 1);
  assert.strictEqual(rt.calls[0].name, 'Bash');
  assert.deepStrictEqual(JSON.parse(rt.calls[0].arguments), { command: 'ls', n: 2 });
  console.log('[PASS] tool_calls 渲染往返一致');

  console.log('全部自测通过 ✔');
}

main().catch((e) => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
