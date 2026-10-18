'use strict';
// 工具调用支持：模型原生 DSML 标记 ⇄ OpenAI tool_calls
//
// DeepSeek 网页版模型调用工具时输出 DSML 标记（网页端同款格式）：
//   <｜｜DSML｜｜ calls>
//   <｜｜DSML｜｜ invoke name="Bash">
//   <｜｜DSML｜｜ parameter name="command" string="true">ls</｜｜DSML｜｜ parameter>
//   </｜｜DSML｜｜ invoke>
//   </｜｜DSML｜｜ calls>
// （闭合标签兼容 </｜｜DSML｜｜ invoke> 与 <｜｜DSML｜｜ /invoke> 两种写法；
//   未闭合的块按「截断到最后」处理，尽量抢救出参数）
//
// 本模块职责：
//   parseToolCalls(text)  标记 → { text, calls:[{id,name,arguments}] }，text 为去掉标记的正文
//   holdIndex(content)    流式正文安全前缀长度（标记定形前先扣住不发，防止泄漏成正文）
//   renderToolsSection()  请求里的 tools / tool_choice → 注入提示词的工具说明
//   renderCallsBlock()    历史里的 tool_calls → DSML 标记（回填 prompt 保持上下文）

const crypto = require('crypto');

const T = '｜｜DSML｜｜';
const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const ATTRS = `((?:\\s+${NAME}="[^"]*")*)`;
const CALL_TAGS = 'tool_?calls?|calls?';

const INVOKE_OPEN_RE = new RegExp(`<${T}\\s*invoke${ATTRS}\\s*>`, 'g');
const INVOKE_CLOSE_RE = new RegExp(`</${T}\\s*invoke\\s*>|<${T}\\s*/\\s*invoke\\s*>`);
const PARAM_OPEN_RE = new RegExp(`<${T}\\s*parameter${ATTRS}\\s*>`, 'g');
const PARAM_CLOSE_RE = new RegExp(`</${T}\\s*parameter\\s*>|<${T}\\s*/\\s*parameter\\s*>`);
const WRAP_TAG_RE = new RegExp(`</?${T}\\s*/?\\s*(?:${CALL_TAGS})\\s*>`, 'g');
const MARKERS = [`<${T}`, `</${T}`];

function attrsOf(s) {
  const out = {};
  const re = new RegExp(`${NAME}="([^"]*)"`, 'g');
  let m;
  while ((m = re.exec(s || ''))) out[m[0].slice(0, m[0].indexOf('='))] = m[1];
  return out;
}

// 解析 <｜｜DSML｜｜ parameter ...>value</...> 载荷；
// string="true" 原样取字符串，否则按 JSON 取数字/布尔/对象
function parseParams(body) {
  const args = {};
  PARAM_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = PARAM_OPEN_RE.exec(body))) {
    const attrs = attrsOf(m[1]);
    const vs = m.index + m[0].length;
    const cm = PARAM_CLOSE_RE.exec(body.slice(vs));
    const raw = cm ? body.slice(vs, vs + cm.index) : body.slice(vs);
    if (!attrs.name) continue;
    if (attrs.string === 'true') {
      args[attrs.name] = raw.replace(/^\r?\n/, '').replace(/\s+$/, '');
    } else {
      const t = raw.trim();
      try {
        args[attrs.name] = JSON.parse(t);
      } catch {
        args[attrs.name] = t;
      }
    }
    PARAM_OPEN_RE.lastIndex = cm ? vs + cm.index + cm[0].length : body.length;
  }
  return args;
}

function parseToolCalls(text) {
  const src = String(text ?? '');
  const calls = [];
  const cuts = []; // 工具调用块 [start, end) 区间
  INVOKE_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = INVOKE_OPEN_RE.exec(src))) {
    const attrs = attrsOf(m[1]);
    const bodyStart = m.index + m[0].length;
    const cm = INVOKE_CLOSE_RE.exec(src.slice(bodyStart));
    const body = cm ? src.slice(bodyStart, bodyStart + cm.index) : src.slice(bodyStart);
    const end = cm ? bodyStart + cm.index + cm[0].length : src.length;
    cuts.push([m.index, end]);
    calls.push({
      id: `call_${crypto.randomUUID().replace(/-/g, '')}`,
      name: attrs.name || '',
      arguments: JSON.stringify(parseParams(body)),
    });
    INVOKE_OPEN_RE.lastIndex = end;
  }

  let out = src;
  if (cuts.length) {
    let plain = '';
    let last = 0;
    for (const [s, e] of cuts) {
      plain += src.slice(last, s);
      last = e;
    }
    out = (plain + src.slice(last)).replace(WRAP_TAG_RE, '');
    out = out.replace(/\n{3,}/g, '\n\n').trim();
  }
  return { text: out, calls };
}

// 流式输出时正文的安全前缀长度：工具调用标记（含未定形的尾部前缀）起始处之前。
// 标记一旦完整出现，其后全部扣住，直到流结束统一解析。
function holdIndex(content) {
  const s = String(content ?? '');
  let min = s.length;
  for (const mk of MARKERS) {
    const i = s.indexOf(mk);
    if (i >= 0 && i < min) min = i;
    for (let k = Math.min(mk.length - 1, s.length); k > 0; k--) {
      if (s.endsWith(mk.slice(0, k))) {
        const p = s.length - k;
        if (p < min) min = p;
        break;
      }
    }
  }
  return min;
}

function parseArgsObj(s) {
  if (s && typeof s === 'object') return s;
  try {
    return JSON.parse(s || '{}') || {};
  } catch {
    return {};
  }
}

// 历史 assistant.tool_calls → DSML 标记块
function renderCallsBlock(toolCalls) {
  const invokes = (toolCalls || [])
    .map((tc) => {
      const fn = tc?.function || tc || {};
      const args = parseArgsObj(fn.arguments);
      const params = Object.entries(args)
        .map(([k, v]) => {
          const isStr = typeof v === 'string';
          const raw = isStr ? v : JSON.stringify(v ?? null);
          return `<${T} parameter name="${k}"${isStr ? ' string="true"' : ''}>${raw}</${T} parameter>`;
        })
        .join('\n');
      return `<${T} invoke name="${fn.name || ''}">\n${params}\n</${T} invoke>`;
    })
    .join('\n');
  return `<${T} calls>\n${invokes}\n</${T} calls>`;
}

// 请求里的 tools / tool_choice → 提示词里的工具说明（含 DSML 输出格式约定）
function renderToolsSection(tools, toolChoice) {
  const lines = [
    '# Tools',
    '',
    'When a tool is needed, emit a tool call block in exactly this format (plain text, never inside code fences):',
    '',
    `<${T} calls>`,
    `<${T} invoke name="tool_name">`,
    `<${T} parameter name="param_name" string="true">param value</${T} parameter>`,
    `</${T} invoke>`,
    `</${T} calls>`,
    '',
    'Rules:',
    '- Add string="true" on string parameters; omit the attribute for number/boolean/object/array',
    '  parameters and write the JSON value instead.',
    `- For parallel calls, put multiple <${T} invoke> blocks in one <${T} calls> block.`,
    '- Put nothing else inside the block and do not describe the call in words first.',
    '',
    'Available tools (JSON Schema):',
    JSON.stringify(tools, null, 2),
  ];
  const choice = toolChoice && typeof toolChoice === 'object' ? toolChoice : null;
  if (toolChoice === 'required' || choice?.type === 'required') {
    lines.push('', 'You must call a tool in this turn; do not answer directly.');
  } else if (choice?.type === 'function' && choice.function?.name) {
    lines.push('', `You must call the tool "${choice.function.name}" in this turn.`);
  }
  return lines.join('\n');
}

module.exports = { parseToolCalls, holdIndex, renderToolsSection, renderCallsBlock, parseParams };
