# ds2api —— DeepSeek 网页版 → 本地 API 代理

把 [chat.deepseek.com](https://chat.deepseek.com) 的网页对话能力包装成**本地 OpenAI 兼容 API**，
任何支持 OpenAI 接口格式的客户端（各种 AI 编程工具、聊天前端、脚本）都可以直接调用。

零第三方依赖（Node.js 原生实现），内置 DeepSeek 网页端同款 PoW 求解器，支持深度思考（R1）与联网搜索。

> ⚠️ **免责声明**：本项目调用的是 DeepSeek 网页版的非公开接口，仅供个人学习研究使用，
> 请遵守 DeepSeek 的服务条款，使用自己的账号，控制调用频率（过高的频率可能导致账号被限流）。

---

## Linux：Docker Compose 一键部署

服务器需已安装 [Docker Engine](https://docs.docker.com/engine/install/) 和
[Docker Compose v2](https://docs.docker.com/compose/install/linux/)，当前用户需能运行 Docker。
将项目复制到服务器，在项目根目录执行（宿主机无需安装 Node.js）：

```bash
bash deploy.sh
```

脚本会构建镜像、后台启动并等待健康检查。首次启动自动生成独立的 **API Key** 和
**Admin Key**，部署成功后显示在终端；后续启动保留原密钥与账号。服务启动日志不打印密钥。

1. 打开 `http://<服务器IP>:3210/admin`，使用 **Admin Key** 登录。
2. 在账号管理中添加自己的 DeepSeek 网页 Token，设置单账号 QPS、RPM、并发与冷却策略。
3. 客户端 Base URL 填 `http://<服务器IP>:3210/v1`，API Key 填脚本显示的 **API Key**，
   模型填 `deepseek-v4.1-flash`。

默认监听服务器 `0.0.0.0:3210`。容器健康只表示服务可以响应，空号池也会通过检查；
实际对话需要添加有效账号。Docker 部署不会自动导入宿主机现有的 `config.json`。

### 端口与日常操作

复制端口配置后按需修改；再次部署会应用新配置：

```bash
cp .env.example .env
# 编辑 .env 中的 DS_PORT=3210、DS_BIND_ADDRESS=0.0.0.0
bash deploy.sh
```

也可临时指定端口：`DS_PORT=8080 bash deploy.sh`。容器内部始终使用 3210，
Docker 部署时不要通过 `config.json` 更改监听端口。

| 命令 | 作用 |
|---|---|
| `bash deploy.sh` | 构建并启动；更新项目代码后再次执行即可重新部署 |
| `bash deploy.sh stop` | 停止并移除容器，保留数据卷 |
| `bash deploy.sh restart` | 重启现有服务并等待健康检查 |
| `bash deploy.sh status` | 查看容器与健康状态 |
| `bash deploy.sh logs` | 持续查看最近日志，Ctrl+C 退出查看 |
| `bash deploy.sh keys` | 在终端重新显示当前 API Key 和 Admin Key |

### 数据持久化与备份

Compose 使用命名卷挂载整个 `/data`：`/data/config.json` 保存账号、Token 与密钥，
`/data/state/` 保存累计统计、请求日志和账号失效/冷却状态。
重启、重新构建和 `bash deploy.sh stop` 均保留这些数据；**不要使用 `docker compose down -v`**，
它会删除数据卷。备份包含凭证，请妥善保管。

在项目根目录执行以下命令，停止写入后打包整个数据卷，再启动服务：

```bash
docker compose stop ds2api
umask 077
docker compose run --rm --no-deps -T --entrypoint tar ds2api -C /data -czf - . > ds2api-backup.tar.gz
bash deploy.sh
```

迁移到新服务器时，将项目和备份复制过去，确保目标使用**全新的空数据卷**，然后执行：

```bash
docker compose build ds2api
docker compose run --rm --no-deps -T --entrypoint tar ds2api -C /data -xzf - < ds2api-backup.tar.gz
bash deploy.sh
```

还原后继续使用备份中的账号与密钥。请勿向正在运行或已有业务数据的数据卷直接解包。

---

## Windows：三步上手（最短路径）

1. **准备**：Windows + [Node.js](https://nodejs.org) 18+（零依赖，不需要 npm install）
2. **授权**：`node login.js <邮箱> <密码>` 写入 DeepSeek 账号 token（过期后重新登录）
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

> Token 有效期以实际鉴权结果为准，失效后重新登录；号池模式也可在管理台更新凭证。

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

## 多账号号池与网页管理台

号池将多个自有账号统一到同一个 `/v1/chat/completions` 入口，客户端仍使用原有的
Base URL 与 `api_key`。管理台位于 **`http://127.0.0.1:3210/admin`**，支持账号增删改、启停、
Token 更新、独立限额、运行状态、成功率和请求日志；账号变更保存到配置文件并立即生效。

### 开始使用

1. 在 `config.json` 中设置独立的 `admin_key`，同时为调用方设置 `api_key`，然后启动服务。
2. 打开 `/admin`，输入 `admin_key` 连接管理台。
3. 在「账号管理」中添加账号，粘贴对应账号的网页 Token，并设置 QPS、RPM、最大并发和冷却时间。
4. 客户端统一调用 `http://127.0.0.1:3210/v1`，由号池自动选择符合限额的可用账号。

也可直接编辑配置。以下字段合并到已有 `config.json` 中即可：

```json
{
  "api_key": "替换为调用方使用的密钥",
  "admin_key": "替换为独立的管理密钥",
  "accounts": [
    {
      "id": "daily",
      "name": "日常账号",
      "token": "替换为第一个账号的网页Token",
      "enabled": true,
      "qps": 1,
      "rpm": 20,
      "max_concurrent": 1,
      "cooldown_seconds": 60,
      "max_cooldown_seconds": 900
    },
    {
      "id": "backup",
      "name": "备用账号",
      "token": "替换为第二个账号的网页Token",
      "enabled": true,
      "qps": 1,
      "rpm": 20,
      "max_concurrent": 1,
      "cooldown_seconds": 60,
      "max_cooldown_seconds": 900
    }
  ],
  "pool_settings": {
    "qps": 1,
    "rpm": 20,
    "max_concurrent": 1,
    "cooldown_seconds": 60,
    "max_cooldown_seconds": 900,
    "queue_timeout_ms": 30000,
    "max_pending": 100,
    "max_attempts": 3
  },
  "logging": {
    "max_log_bytes": 10485760,
    "retention_files": 5
  }
}
```

`accounts` 中未填写的限额使用 `pool_settings` 默认值。账号 `id` 保持唯一且稳定，
便于关联历史统计。未配置 `accounts` 时兼容原来的单个 `token`；一旦配置 `accounts`，
就以该数组为准，空数组表示号池没有账号。直接修改账号配置或通过 CLI 更新 Token 后，
运行中的服务约 1 秒内自动加载；管理台或管理 API 修改会立即生效。监听地址、密钥、
全局 `pool_settings` 等服务设置修改后需重启。
管理密钥也可通过 `DS_ADMIN_KEY` 设置；未设置管理密钥时，管理 API 拒绝访问。

号池模式下，CLI 登录或导入凭证需指定账号 ID，例如：

```bash
node login.js --account work --token <token>
node login.js --account work <邮箱> <密码>
```

已有账号会更新凭证，不存在的账号会添加。更新 Token 且未指定新的到期时间时，会清除旧到期时间，
避免新凭证仍被旧时间判定为到期。

### 调度、限流与凭证状态

- **自动分配**：轮询符合条件的账号，每个账号独立持有凭证、会话客户端和频率预算。
- **QPS / RPM**：分别计算过去 1 秒、60 秒内开始的账号请求尝试数，使用滑动窗口。
  一次请求换用其他账号时，每次尝试都会占用对应账号的预算；上游协议内部的会话、PoW 等 HTTP
  请求不等同于一次对话尝试。限额须为正整数。
- **最大并发**：限制同一账号正在处理的尝试数量，与 QPS/RPM 同时生效。
  可用账号暂时忙碌或预算耗尽时进入有界队列；超过 `max_pending` 或等待
  `queue_timeout_ms` 后返回错误，客户端取消时会释放排队项或账号占用。
- **限流冷却**：上游限流后，账号进入基础冷却；连续限流按指数延长，达到配置上限为止。
  上游 `Retry-After` 要求等待更长时间时遵循上游。冷却结束后自动重新参与调度。
- **Token 失效**：鉴权失败后将账号标记为失效，停止分配请求。禁言、验证码等状态需要人工处理。
  在管理台编辑账号并填入新 Token 可恢复凭证状态；编辑时 Token 留空会保留原凭证。
  已知准确到期时间时可填写 `token_expires_at`，到期后停止调度；项目不会猜测有效期或自动刷新账号 Token。
- **失败重试**：只在尚未输出内容、错误类型允许重试时尝试其他账号，并受 `max_attempts` 限制。
  已输出思考或正文后不会换号拼接响应。

QPS、RPM 和并发限制作用于**当前服务进程**。该实现用于单机单进程号池，多个进程不会共享实时
限额与排队状态；不要让多个实例同时写入同一配置文件或数据目录。

### 状态、统计与日志

管理台每 5 秒更新一次可见页面的号池状态，可区分可用、处理中、频率受限、冷却、凭证失效、
未配置凭证和停用账号。请求日志支持按账号与结果筛选，并提供分页。

统计分为两种口径：客户端请求统计一个最终结果，账号统计记录每次上游尝试。
成功率为 `成功 / (成功 + 失败)`，取消单独计数，不计入成功率分母；平均耗时包含已记录的取消请求。
因此一次先失败再换号成功的请求，会增加一次请求成功、一次账号失败和一次账号成功。

数据默认保存在配置文件所在目录的 `data/` 下，可通过 `data_dir` 或 `DS_DATA_DIR` 更改：

- `stats.json`：累计请求与账号尝试统计，重启后恢复，不随日志轮转清空。
- `requests.jsonl` 及轮转文件：请求时间、请求 ID、账号 ID、结果、耗时、尝试次数与错误分类。
  默认单文件 10 MiB、最多保留 5 个日志文件。管理台与日志 API 最多查询最近 10,000 条记录，
  超过此数量时显示截断提示；更早记录可在仍保留的磁盘轮转文件中查看，超过轮转保留范围则会删除。
- `pool-state.json`：保存账号失效与冷却状态，重启不会自动解除尚未结束的冷却或失效标记。

日志不保存 Token、密码、请求提示词或响应正文。管理 API 返回的账号数据也不包含 Token，
管理密钥只保留在浏览器当前页面内存中，刷新或断开连接后清除。凭证仍存于本地配置文件，
请妥善保管配置和数据目录。文件采用批量异步写入，进程突然退出时最近尚未写入的数据可能丢失。
磁盘写入失败或日志积压导致丢弃时，管理台显示独立告警；请检查数据目录权限、磁盘空间及写入负载。

### 管理 API

以下接口使用 `Authorization: Bearer <admin_key>`，与对话 API 的 `api_key` 分开：

| 端点 | 说明 |
|---|---|
| `GET /admin/api/status` | 号池实时状态与累计统计 |
| `GET /admin/api/accounts` | 脱敏账号列表 |
| `POST /admin/api/accounts` | 添加账号，参数对应账号配置字段 |
| `PATCH /admin/api/accounts/:id` | 更新账号、凭证或限额；省略 Token 表示保留 |
| `DELETE /admin/api/accounts/:id` | 删除账号，保留已有历史日志与累计统计 |
| `GET /admin/api/logs` | 分页查询日志，支持 `limit`、`offset`、`account_id`、`outcome` |

`outcome` 可选 `success`、`failed`、`cancelled`。例如：

```bash
curl http://127.0.0.1:3210/admin/api/status \
  -H "Authorization: Bearer <admin_key>"

curl "http://127.0.0.1:3210/admin/api/logs?limit=20&offset=0&outcome=failed" \
  -H "Authorization: Bearer <admin_key>"
```

账号池与统计自测可分别运行 `node test-pool.js` 和 `node test-telemetry.js`；
原有 `node test.js`、`node test-mock.js` 继续用于协议与兼容 API 回归验证。
此外，`node test-upstream.js` 验证上游错误与流中断处理，`node test-server-pool.js`
验证管理 API 和号池请求链路，`node test-config-login.js` 验证配置热加载与 CLI 凭证更新。

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

- **Token 可能失效**，以实际鉴权结果或配置的到期时间为准；在管理台更新凭证或重新登录
- 网页端有**频率限制**，请求过密会 429（"message sent too frequently"），稍等再试
- 非官方接口，DeepSeek 改版可能失效：报 PoW / 协议类错误时，可先尝试更新
  config.json 的 `x_client_version`，或关注本项目更新
- 返回的 `usage` 是估算值（网页端不返回精确 token 用量）
- 工具调用是提示词层面的模拟（网页端无原生 function calling）：偶发不按格式发起
  调用时可让提示词更明确（如「用 XX 工具完成」），或重试一次
- 号池按单机单进程设计，多个实例不会共享限额；对话 API 与管理 API 分别使用调用密钥和管理密钥

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
node test-pool.js  # 账号调度、滑动窗口、队列、冷却与失效管理
node test-telemetry.js  # 脱敏日志、轮转与统计持久化
node test-upstream.js  # 上游错误与流中断处理（本地 mock）
node test-server-pool.js  # 管理 API、号池请求与日志（本地 mock）
node test-config-login.js  # 配置热加载与 CLI 凭证更新
node test-docker.js  # 容器入口、密钥保留和鉴权（无需 Docker）
bash test-deploy.sh  # 部署脚本成功与失败路径（Docker 命令替身）
```

---

## 文件结构

```
ds2api/
├── Dockerfile / compose.yaml  # Linux 容器构建与持久化部署
├── deploy.sh            # 一键部署、启停、日志与密钥查询
├── docker/entrypoint.js # 容器首次配置与密钥初始化
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

**启动后调用返回 503「没有可用账号」**
→ 在 `/admin` 添加账号并填入 Token，或用 `node login.js --account work --token <token>` 导入。
检查账号是否已启用、凭证是否失效，以及 `token_expires_at` 是否已经到期。

**返回 401「DeepSeek 上游错误」**
→ 凭证鉴权失败；重新登录，并在管理台或通过 CLI 更新对应账号的 Token。

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
