# ds2api —— DeepSeek 网页版 → 本地 API 代理

把 [chat.deepseek.com](https://chat.deepseek.com) 的网页对话能力包装成**本地 OpenAI 兼容 API**，
任何支持 OpenAI 接口格式的客户端（各种 AI 编程工具、聊天前端、脚本）都可以直接调用。

零第三方依赖（Node.js 原生实现），内置 DeepSeek 网页端同款 PoW 求解器，支持深度思考（R1）与联网搜索。

> ⚠️ **免责声明**：本项目调用的是 DeepSeek 网页版的非公开接口，仅供个人学习研究使用，
> 请遵守 DeepSeek 的服务条款，使用自己的账号，控制调用频率（过高的频率可能导致账号被限流）。

---

## 三步上手（最短路径）

1. **准备**：Windows + [Node.js](https://nodejs.org) 18+（零依赖，不需要 npm install）
2. **授权**：`node login.js <邮箱> <密码>` 写入 DeepSeek 账号 token（约 24 小时过期，过期重登）
3. **启动**：双击 `start.bat`（或先跑一次 `install-shortcuts.bat` 生成桌面启停快捷方式）

然后在任何 OpenAI 兼容客户端里填：

- Base URL：`http://127.0.0.1:3210/v1`（端口可在 config.json 改）
- API Key：config.json 的 `api_key`（留空 = 不校验；填了则必须一致）
- 模型：`deepseek-v4.1-flash`

---

## 快速开始

### 1. 环境要求

- Windows（启停脚本、桌面快捷方式为 Windows 专用）
- [Node.js](https://nodejs.org) 18 或更高版本（无需 npm install，本项目零依赖）

### 2. 生成桌面快捷方式（一次性）

双击 **`install-shortcuts.bat`**，桌面上会生成三个快捷方式：

| 快捷方式 | 作用 |
|---|---|
| 启动DeepSeek代理 | 启动本地 API 服务（日志在窗口里，**关窗即停止**） |
| 停止DeepSeek代理 | 停止服务（按 PID / 端口兜底，只结束 node 进程） |
| DeepSeek代理配置 | 用记事本打开 config.json（token、端口等） |

### 3. 配置 DeepSeek 账号 token

方式一：账号密码登录（自动写入 config.json）：

```bash
node login.js <邮箱> <密码>
node login.js --phone <手机号> <密码>     # 手机号登录（+86）
```

方式二：从浏览器手动提取（需要过验证码时用这个）：

1. 浏览器登录 chat.deepseek.com
2. `F12` → Application → Local Storage → `https://chat.deepseek.com` → `userToken`
3. 其中 JSON 的 `value` 字段值就是 token

> 如果 Local Storage 里没有 `userToken`（新版可能只存用户信息），
> 改用 Network 面板：随便发条消息 → 点开任意 `api/v0/...` 请求 →
> Request Headers 里的 `authorization: Bearer <token>`，`Bearer ` 后面那串就是。

4. `node login.js --token <粘贴的token>`（或直接填进 config.json 的 `token`）

> token 有效期约 24 小时，过期后接口会返回 401，重新执行登录即可。

### 4. 启动并使用

双击桌面 **启动DeepSeek代理**，看到 `ds2api 已启动` 即可：

```bash
# 健康检查
curl http://127.0.0.1:3210/health

# 模型列表
curl http://127.0.0.1:3210/v1/models

# 对话（流式）
curl http://127.0.0.1:3210/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","stream":true,"messages":[{"role":"user","content":"1+1等于几"}]}'
```

客户端配置（以任意 OpenAI 兼容客户端为例）：

- **Base URL**：`http://127.0.0.1:3210/v1`
- **API Key**：config.json 的 `api_key`（接入 ZCode 时两边自动保持一致）
- **模型**：`deepseek-v4.1-flash`

### 接入 ZCode

ds2api 已注册为 ZCode 的模型供应商（providerId `new-provider-ds2api`，无需重启即生效），
模型选择器里选 **`new-provider-ds2api/deepseek-v4.1-flash`**。

- **思考模式**：用模型旁边的思考级别选择器控制（`disabled` / `low` / `high` / `max`），
  选 `disabled` 即关闭思考；默认 `max`（开）。
- **搜索模式**：ZCode 侧暂无对应选择器，用 config.json 的 `search_enabled` 全局开关
  （默认 `false`）；API 直调时也可每次传 `"search_enabled": true`。

> 使用前先双击桌面「启动DeepSeek代理」（ZCode 不会自动帮你启动服务）。

如需手动（重新）接入或迁移到别的机器：编辑
`C:\Users\<用户名>\.zcode\v2\provider_config.json`，在
`config.providerConfigRules.providerRules` 里照抄其它供应商的格式加一条
（`api.baseUrl` 填 `http://127.0.0.1:3210/v1`，`access.apiKey` 填 config.json 的 `api_key`），
并把 `providerId` 追加到 `config.providerOrder`。改完即生效。

---

## 实现原理（供二次开发 / 排障）

网页版没有公开 API，本项目按网页客户端的行为直接调用其内部接口（`chat.deepseek.com/api/v0`）：

1. **鉴权**：网页登录后存于 Local Storage 的 `userToken` → 请求头 `Authorization: Bearer <token>`
2. **PoW**：每个对话前 `POST /chat/create_pow_challenge` 拿**一次性**挑战，
   用 DeepSeek 官方同款 WASM 求解器（`lib/sha3_wasm.wasm`）解出 nonce，
   以 `x-ds-pow-response` 头随请求携带；挑战复用会被拒（`INVALID_POW_RESPONSE`），
   代码已按「每次新挑战 + 失效自动换挑战重试一次」处理
3. **对话**：`POST /chat/completion` 的响应就是 SSE **补丁流**（`{"p","o","v"}` fragments 协议），
   `THINK` 片段 → `reasoning_content`，`RESPONSE` 片段 → `content`，`status=FINISHED` 收尾
4. **OpenAI 层**：`server.js` 把以上包装成 `/v1/chat/completions`（流式 / 非流式），
   思考 / 搜索开关从请求字段（`reasoning_effort` 等）或 config 默认值映射到
   `thinking_enabled` / `search_enabled`；`tools` 注入提示词、模型的 DSML 工具调用
   标记在 `lib/tools.js` 解析回 `tool_calls`

改动后跑自测：`node test.js`（PoW 实测向量 + SSE 协议单测）、
`node test-mock.js`（mock 上游全链路集成测试，无需联网）。

## 限制与注意

- **token 约 24 小时过期**，接口报 401 就重新 `node login.js` 一次
- 网页端有**频率限制**，请求过密会 429（"message sent too frequently"），稍等再试
- 非官方接口，DeepSeek 改版可能失效：报 PoW / 协议类错误时，可先尝试更新
  config.json 的 `x_client_version`，或关注本项目更新
- 返回的 `usage` 是估算值（网页端不返回精确 token 用量）
- 工具调用是提示词层面的模拟（网页端无原生 function calling）：偶发不按格式发起
  调用时可让提示词更明确（如「用 XX 工具完成」），或重试一次
- 仅建议单人本地使用；不要暴露到公网（config.json 的 `api_key` 是唯一防线）

## API 说明

| 端点 | 说明 |
|---|---|
| `GET /health` | 健康检查（含 token 配置状态） |
| `GET /v1/models` | 模型列表 |
| `POST /v1/chat/completions` | 对话补全，支持 `stream: true`（SSE）、非流式与 `tools` / `tool_calls` |

### 模型与能力开关

网页版现在是统一模型 **`deepseek-v4.1-flash`**（不再分 chat / reasoner），
思考、搜索是两个独立开关：

| 开关 | 请求字段（任一写法即可） | 默认 |
|---|---|---|
| 深度思考 | `reasoning_effort`（`none`/`disabled` 关，其余开）、`thinking_enabled`、`enable_thinking`、`thinking: {type}`、`reasoning: {effort}`、`output_config: {effort}` | 开（config `thinking_enabled`） |
| 联网搜索 | `search_enabled`、`web_search`、`search` | 关（config `search_enabled`） |

深度思考的输出放在 `reasoning_content` 字段（与 DeepSeek 官方 API 一致），正文在 `content`。

多轮对话按 OpenAI 惯例传完整 `messages` 历史（内部会合并成单段提示词发起新会话）。

### 工具调用（function calling）

请求里带 `tools`（OpenAI 格式）即可让模型调用工具（本地执行 Bash、读文件等由客户端完成）：

- `tools` 定义会注入提示词，模型按网页端原生的 DSML 标记发起调用，代理解析后以标准
  `tool_calls` 字段返回（`finish_reason: "tool_calls"`，流式 / 非流式均支持，
  标记不会泄漏成正文）
- 客户端拿到 `tool_calls` 后本地执行，把结果以 `role: "tool"` 消息回传即可续聊；
  `assistant.tool_calls` 与工具结果会自动回填提示词
- `tool_choice: "none"` 不注入工具也不识别调用标记；`"required"` 或指定函数名会强制要求调用

---

## 配置说明（config.json）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `3210` | 本地监听地址与端口 |
| `api_key` | 空 | 本地 API 鉴权；非空时客户端需带 `Authorization: Bearer <api_key>` |
| `token` | 空 | DeepSeek 网页版 token（login.js 自动写入） |
| `base_url` | `https://chat.deepseek.com` | 上游地址 |
| `x_client_version` | `2.5.0` | 伪装的网页端版本号，失效时可尝试更新 |
| `thinking_enabled` / `search_enabled` | `true` / `false` | 思考 / 搜索的默认开关（请求里有对应字段时以请求为准） |
| `extra_headers` | `{}` | 附加请求头（如需带 Cookie：`{"cookie": "cf_clearance=..."}`） |
| `user_agent` | 空（Chrome 131） | 自定义 UA；sec-ch-ua 等指纹头会自动与 UA 保持一致 |
| `accept_language` | `zh-CN,zh;q=0.9,en;q=0.8` | Accept-Language |
| `risk_headers` | `true` | 自动获取风控头 x-hif-leim / x-hif-dliq（10 分钟缓存） |
| `idle_timeout_ms` | `120000` | 上游流空闲超时（毫秒） |

也支持环境变量覆盖：`DS_HOST`、`DS_PORT`、`DS_TOKEN`、`DS_BASE_URL`、`DS_API_KEY`。

---

## 自测

```bash
node test.js       # PoW 已知答案校验 + SSE/补丁协议单测
node test-mock.js  # mock 上游的全链路集成测试（流式/非流式，无需联网与 token）
```

---

## 文件结构

```
ds2api/
├── server.js            # OpenAI 兼容代理服务（主程序）
├── login.js             # 登录 / 写入 token
├── config.json          # 运行配置（含 token，勿提交 git）
├── config.example.json  # 配置模板
├── lib/
│   ├── dsweb.js         # DeepSeek 网页协议客户端（会话/PoW/SSE 补丁流）
│   ├── tools.js         # 工具调用：DSML 标记 ⇄ OpenAI tool_calls
│   ├── pow.js           # PoW 求解（官方 sha3_wasm.wasm，已对实测向量验证）
│   └── sha3_wasm.wasm   # DeepSeek 网页端同款求解器（缺失时自动下载）
├── start.bat / stop.bat # 启动 / 停止
├── install-shortcuts.bat + create-shortcuts.ps1  # 生成桌面快捷方式
└── test.js / test-mock.js
```

---

## 常见问题

**请求被 WAF 拦截（429 / "Request Blocked" HTML 页）**
→ 代理已内置完整浏览器指纹请求头（sec-ch-ua、sec-fetch-\*、accept-language、
Origin/Referer），并自动附带 x-hif-leim / x-hif-dliq 风控头，正常情况不会被拦。
仍被拦时：把浏览器完整请求头粘贴到 config.json 的 `extra_headers`（特别是 `cookie`，
如 cf_clearance），或调低请求频率。

**启动后调用返回 401「尚未配置 token」**
→ 先执行 `node login.js <邮箱> <密码>`，或手动填 config.json 的 `token`。

**返回 401「DeepSeek 上游错误」**
→ token 已过期（约 24 小时），重新登录一次。

**返回 429 / 「message sent too frequently」**
→ 请求过于频繁，稍等再试；网页端对账号有频率限制。

**提示 PoW 求解器缺失**
→ `lib/sha3_wasm.wasm` 丢失。联网后重启服务会自动下载；或从
`https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm`
手动下载保存到 `lib/sha3_wasm.wasm`。

**端口被占用**
→ 改 config.json 的 `port`，或先运行「停止DeepSeek代理」（会自动清理占端口的 node 进程）。

**中文乱码**
→ 启停脚本已按中文 Windows 控制台编码（GBK）制作。如果是非中文系统，
建议直接用 `node server.js` 启动（Node 输出不受代码页影响）。
