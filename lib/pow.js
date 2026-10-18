'use strict';
// DeepSeek 网页版 PoW（工作量证明）求解器
//
// 服务端要求每个 /chat/completion 请求带 x-ds-pow-response 头：
//   base64(JSON{algorithm, challenge, salt, answer, signature, target_path})
// 其中 answer 是满足下式的十进制 nonce：
//   hex(DeepSeekHashV1(`${salt}_${expire_at}_${nonce}`)) === challenge
//
// DeepSeekHashV1 是 DeepSeek 自定义哈希（Keccak 变体：23 轮、跳过 RC[0]）。
// 本模块直接调用 DeepSeek 官方网页端同款 WASM 求解器（lib/sha3_wasm.wasm），
// 已对实测抓包向量验证：challenge 168efa30… 在 difficulty=144000 下正确求得
// nonce=58595。若本地 wasm 文件缺失，会尝试从 DeepSeek CDN 自动补下载。

const fs = require('fs');
const path = require('path');

const WASM_PATH = path.join(__dirname, 'sha3_wasm.wasm');
const WASM_CDN_URLS = [
  'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm',
];

let wasmState = null; // {instance, malloc, stack, solve}
let downloadTried = false;

async function ensureWasmFile() {
  if (fs.existsSync(WASM_PATH)) return;
  if (downloadTried) return;
  downloadTried = true;
  for (const url of WASM_CDN_URLS) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 1000 || buf[0] !== 0x00 || buf[1] !== 0x61) continue;
      fs.writeFileSync(WASM_PATH, buf);
      return;
    } catch (e) {
      // 尝试下一个源
    }
  }
}

async function loadWasm() {
  if (wasmState) return wasmState;
  await ensureWasmFile();
  if (!fs.existsSync(WASM_PATH)) {
    throw new Error(
      `PoW 求解器缺失：${WASM_PATH} 不存在且自动下载失败。` +
        `请手动下载 ${WASM_CDN_URLS[0]} 保存为该文件。`
    );
  }
  const buf = fs.readFileSync(WASM_PATH);
  const mod = await WebAssembly.compile(buf);
  const instance = await WebAssembly.instantiate(mod, {});
  const exp = instance.exports;
  if (typeof exp.wasm_solve !== 'function') {
    throw new Error('sha3_wasm.wasm 缺少 wasm_solve 导出，文件可能损坏');
  }
  wasmState = {
    instance,
    malloc: exp.__wbindgen_export_0,
    stack: exp.__wbindgen_add_to_stack_pointer,
    solve: exp.wasm_solve,
  };
  return wasmState;
}

// 调用约定与 DeepSeek 官方 wasm-bindgen 胶水一致（见 pow_solver.js）：
// wasm_solve(retptr, chPtr, chLen, pfxPtr, pfxLen, difficulty)
// 结果写在 retptr：i32 status（0=未找到）+ f64 answer
function wasmSolve(wasm, challengeHex, prefix, difficulty) {
  const { instance, malloc, stack, solve } = wasm;
  const writeStr = (str) => {
    const bytes = Buffer.from(str, 'utf-8');
    const ptr = malloc(bytes.length, 1);
    new Uint8Array(instance.exports.memory.buffer).set(bytes, ptr);
    return { ptr, len: bytes.length };
  };
  const retptr = stack(-16);
  try {
    const ch = writeStr(challengeHex);
    const pf = writeStr(prefix);
    solve(retptr, ch.ptr, ch.len, pf.ptr, pf.len, difficulty);
    const mem = instance.exports.memory.buffer;
    const status = new Int32Array(mem)[retptr / 4];
    if (status === 0) return null;
    return Math.floor(new Float64Array(mem)[(retptr + 8) / 8]);
  } finally {
    stack(16);
  }
}

/**
 * 求解 PoW 挑战，返回可直接放入 x-ds-pow-response 头的 base64 字符串。
 * @param {object} challenge 数据.biz_data.challenge
 * @returns {Promise<{header: string, answer: number, tookMs: number}>}
 */
async function solveChallenge(challenge) {
  const {
    algorithm,
    challenge: ch,
    salt,
    signature,
    difficulty,
    expire_at: expireAt,
    target_path: targetPath,
  } = challenge;
  if (algorithm && algorithm !== 'DeepSeekHashV1') {
    throw new Error(`不支持的 PoW 算法: ${algorithm}`);
  }
  const wasm = await loadWasm();
  const started = Date.now();
  const answer = wasmSolve(wasm, ch, `${salt}_${expireAt}_`, difficulty);
  if (answer === null) throw new Error('PoW 求解失败（wasm 未找到答案，请重试）');
  const payload = {
    algorithm: algorithm || 'DeepSeekHashV1',
    challenge: ch,
    salt,
    answer,
    signature,
    target_path: targetPath,
  };
  return {
    header: Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64'),
    answer,
    tookMs: Date.now() - started,
  };
}

module.exports = { solveChallenge, loadWasm, wasmSolve, WASM_PATH };
