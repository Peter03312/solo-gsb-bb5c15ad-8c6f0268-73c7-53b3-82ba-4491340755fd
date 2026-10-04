# 水质实验室 · 样本分装与混样溯源工作台

基于 **Node.js + Express + SQLite（better-sqlite3）** 的 Web 工作台，用于管理水质样本的
原瓶登记、分装 / 混样操作、余量守恒校验、完整来源谱系追溯与历史操作更正。

本轮新增**批次（连续分装 / 混样）**：一个批次号承载按录入顺序排列的多条操作，
先预演（逐条可行性、受影响瓶预计余量、提交凭据，不写库），再在**一个事务**内核对凭据、
重放全账、整批落库；批内可引用前项生成的瓶，已提交批次幂等。

## 一键启动（Docker Compose）

```bash
docker compose up --build
```

容器启动时会自动安装依赖、建表；数据库为空时写入示例数据（3 个原始瓶 + 2 条操作）。

浏览器访问：**http://localhost:3000**

停止并删除数据：`docker compose down -v`（数据保存在 named volume `lab-data` 中，普通 `down` 不丢数据）。

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 监听端口（Compose 已映射 3000:3000） |
| `DB_PATH` | 容器内 `/app/data/lab.db`，本地 `./data/lab.db` | SQLite 数据库文件路径，启动时自动建目录、建表、初始化 |
| `PREVIEW_TTL_MS` | `1800000`（30 分钟） | 批次预演凭据有效期（毫秒） |
| `PREVIEW_SECRET` | 进程启动时随机生成 | 凭据 HMAC 密钥；配置固定值可让凭据跨进程重启有效（默认重启后旧凭据作废、须重新预演） |

## 本地运行（不用 Docker）

```bash
npm install
npm start          # 访问 http://localhost:3000
```

要求 Node.js ≥ 18。better-sqlite3 为原生模块，标准 node 镜像 / 常见桌面环境均可直接安装。

## 页面功能

- **瓶子总览**：每个瓶的类型（原始瓶 / 衍生瓶）、创建或采样时间、初始体积、当前余量；
  点击任意行查看该瓶的**完整来源谱系**（向上递归至原始瓶）及相关操作记录。
- **登记原始瓶**：录入瓶编号、采样时间、初始体积（mL，正整数）。
- **新建分装 / 混样**：录入唯一操作号、目标瓶编号（须为新编号）、操作时间、
  一个或多个来源瓶及各自取用体积；目标瓶体积 = 取用量之和。
- **批次分装 / 混样**（新）：录入批次号与多条操作（操作号、目标瓶、操作时间、来源瓶与
  取用毫升数，按录入顺序排列）；先点“预演”查看**逐条可行性**与**受影响瓶预计余量**
  （完全不写库），可行后点“提交批次”。任一条目有问题时按条目指出，整批不落库。
  修改任何内容或切换批次号后凭据立即失效，需重新预演；台账被他人改动后提交会被拒绝并提示重新预演。
- **操作记录与更正**：列出全部操作；点“更正”可修改该操作的来源与取用量，
  提交后按操作顺序重算相关瓶余量。

## 业务规则与一致性设计

- **唯一操作号 + 幂等**：`op_id` 为主键。同一操作号重复提交**相同内容**时幂等返回
  （HTTP 200，不重复扣量）；内容不一致返回 409 冲突。
- **来源约束**：同一操作内来源瓶不得重复；取用体积必须为正整数；来源瓶必须已存在；
  操作时间不得早于任一来源瓶的创建（采样）时间。
- **任一时刻不超用**：每次写入（新操作 / 更正）后，在事务内按
  （操作时间, 入库顺序）重放全量台账，任一瓶余量为负即整体回滚，
  返回 409 及冲突明细（操作号、瓶、需取量、可用量）。
- **历史更正**：更正取用量后按操作顺序重算所有受影响瓶；若导致后续操作超用，
  **整次更正拒绝并回滚，原数据保持不变**，响应中指出冲突记录。
- **并发守恒**：better-sqlite3 为同步驱动，所有写操作包裹在事务中串行执行，
  并发争用同一来源瓶时不会出现超扣；已用并发压测验证（10 并发争用 400 mL，
  恰好 4 笔成功、余量归零不为负；5 并发重复提交同一操作号仅扣量一次）。
- **批次预演 / 提交**：
  - **预演** `POST /api/batches/preview` 只在内存中把现有台账与整批计划合并，按
    （操作时间, 稳定入库顺序）重放全账；批内同时间按录入顺序。返回逐条可行性
    （`entries[].viable/issues`）、受影响瓶的**当前余量 vs 预计余量**、以及绑定
    **计划内容指纹 + 当前台账指纹 + 有效期**的 HMAC 提交凭据，**不写入任何数据**。
  - **批内前向引用**：第 N 条可以引用第 1…N-1 条生成的瓶；引用后项、引用自身或将生成的瓶
    均按“来源缺失”指出条目。引用现有瓶或前项瓶时，操作时间均不得早于该瓶创建时间。
  - **整批校验、整批不落库**：批内或与现有编号冲突（操作号 / 目标瓶）、条目内重复来源、
    非法体积、非法时间、空来源、来源缺失、来源早于创建、任一时刻超用，均按条目给出
    `code + message`（必要时附瓶、需取量、可用量），整批拒绝、无任何数据变更。
  - **提交** `POST /api/batches/commit` 在一个事务内：先做同批次号幂等判定 → 校验凭据
    （签名 / 有效期 / 批次号 / 计划指纹）→ 比对台账指纹 → 再跑一遍与预演相同的全账重放
    → 按录入顺序分配入库顺序号写入全部操作、衍生瓶、来源及批次记录，最后重放真实全账复核。
  - **幂等与冲突**：已成功提交的批次用相同内容（不依赖凭据）重复请求 → HTTP 200
    幂等返回、不再扣量；同批次号不同内容 → 409 `BATCH_CONFLICT`。
  - **重新预演**：预演后若台账（瓶 / 操作 / 来源）变化（含他人登记 / 更正 / 其它批次提交），
    提交返回 409 `LEDGER_CHANGED`；凭据过期 / 伪造 / 与计划不匹配 → 409 `STALE_PREVIEW`；
    服务进程重启（默认随机密钥）同样要求重新预演。
  - **即时可见 + 既有契约不变**：批次提交成功后立即进入现有余量查询、操作记录与
    谱系查询；单条登记（`POST /api/operations`）、更正
    （`POST /api/operations/:op_id/correct`，含对批次内操作的更正）与各查询接口契约保持不变。
- **明确报错**：编号冲突（409）、来源不存在（400）、操作时间早于来源创建时间（400）、
  体积非正整数（400）、超用（409）等均以 JSON `error.code / message / details` 返回，
  页面顶部同步展示。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/bottles` | 登记原始瓶 `{bottle_id, sample_time, initial_volume}` |
| `POST` | `/api/operations` | 单条登记操作 `{op_id, target_bottle, op_time, sources:[{bottle, volume}]}`（契约不变） |
| `POST` | `/api/operations/:op_id/correct` | 更正取用量 `{sources:[{bottle, volume}]}`（契约不变，适用于批次内操作） |
| `POST` | `/api/batches/preview` | **批次预演**（不写库）`{batch_id, operations:[…]}` |
| `POST` | `/api/batches/commit` | **批次提交** `{batch_id, operations:[…], credential:{token}}` |
| `GET` | `/api/batches` | 已提交批次列表（指纹、条目数、提交时间） |
| `GET` | `/api/batches/:id` | 单批次详情：按入库顺序列出条目与来源明细 |
| `GET` | `/api/bottles` | 全部瓶及当前余量 |
| `GET` | `/api/bottles/:id` | 单瓶详情：余量、来源谱系、相关操作 |
| `GET` | `/api/operations` | 全部操作记录（含批次号 `batch_id`、来源明细与目标体积） |

时间格式统一为 `YYYY-MM-DDTHH:MM`（页面用 `datetime-local` 控件，也接受带秒），
体积单位为毫升（正整数）。批次单次最多 500 条、每条最多 100 个来源。

### 批次调用示例（curl）

```bash
BASE=http://localhost:3000

# 1) 预演：两条操作，第 2 条引用第 1 条生成的瓶 B-MIX1（批内前向引用）
curl -s -X POST "$BASE/api/batches/preview" -H 'Content-Type: application/json' -d '{
  "batch_id": "BATCH-20261004-01",
  "operations": [
    {"op_id":"OP-2001","target_bottle":"B-MIX1","op_time":"2026-10-04T09:00",
     "sources":[{"bottle":"W2026-001","volume":100},{"bottle":"W2026-002","volume":50}]},
    {"op_id":"OP-2002","target_bottle":"B-ALQ1","op_time":"2026-10-04T10:00",
     "sources":[{"bottle":"B-MIX1","volume":120}]}
  ]
}' > /tmp/preview.json

cat /tmp/preview.json
# viable=true；entries[].viable/issues 逐条结论；affected_bottles 当前→预计余量；
# credential.token 为提交凭据（另含 plan_digest / ledger_digest / expires_at）

# 2) 提交：批次内容必须与预演时**逐字一致**，并原样回传凭据
TOKEN=$(node -e 'const j=require("/tmp/preview.json");process.stdout.write(j.credential.token)')
curl -s -X POST "$BASE/api/batches/commit" -H 'Content-Type: application/json' -d "{
  \"batch_id\": \"BATCH-20261004-01\",
  \"operations\": [
    {\"op_id\":\"OP-2001\",\"target_bottle\":\"B-MIX1\",\"op_time\":\"2026-10-04T09:00\",
     \"sources\":[{\"bottle\":\"W2026-001\",\"volume\":100},{\"bottle\":\"W2026-002\",\"volume\":50}]},
    {\"op_id\":\"OP-2002\",\"target_bottle\":\"B-ALQ1\",\"op_time\":\"2026-10-04T10:00\",
     \"sources\":[{\"bottle\":\"B-MIX1\",\"volume\":120}]}
  ],
  \"credential\": {\"token\": \"$TOKEN\"}
}"

# 3) 重复提交相同批次 → 200 {"ok":true,"idempotent":true,...}，不再扣量（凭据可任意）
#    同批次号不同内容 → 409 BATCH_CONFLICT
#    预演后台账变化   → 409 LEDGER_CHANGED（重新预演）
#    凭据失效/过期    → 409 STALE_PREVIEW（重新预演）

# 4) 提交结果立即进入既有查询
curl -s "$BASE/api/bottles/B-ALQ1"     # 余量 + 完整谱系（B-ALQ1 → B-MIX1 → 原始瓶）
curl -s "$BASE/api/operations"         # 新增两条，batch_id = BATCH-20261004-01
curl -s "$BASE/api/batches/BATCH-20261004-01"
```

预演不可行时响应仍为 HTTP 200（预演本身成功），`viable=false` 且
`entries[].issues` 逐条列出问题码，例如：

```json
{ "index": 3, "op_id": "OP-2003", "viable": false,
  "issues": [ {"code":"OVERDRAW","message":"第 3 条在 2026-10-04T11:00 从瓶 B-MIX1 取 999 mL，该时刻可用仅 30 mL（超用）",
               "bottle":"B-MIX1","requested":999,"available":30} ] }
```

问题码：`BAD_ID` / `BAD_TIME` / `BAD_VOLUME` / `NO_SOURCES` / `DUP_SOURCE` /
`OP_ID_CONFLICT`（批内或与现有冲突）/ `BOTTLE_CONFLICT` / `SOURCE_NOT_FOUND`
（含引用后项瓶）/ `TIME_BEFORE_SOURCE` / `OVERDRAW`。整批提交时若仍不可行返回
409 `BATCH_REJECTED`，`details` 为上述逐条问题数组，**整批不落库**。

## 项目结构

```
├── Dockerfile            # node:20，构建时安装依赖，启动时确保依赖并初始化数据
├── docker-compose.yml    # 一键启动，映射 3000 端口，named volume 持久化数据
├── package.json
├── server.js             # Express 服务 + SQLite 台账 + 守恒校验 + 谱系查询 + 批次预演/提交
└── public/index.html     # 单页工作台（总览 / 登记 / 单条 / 批次 / 记录与更正）
```

## 兼容性

启动时自动为旧版数据库补列（`operations.batch_id`）并建 `batches` 表，既有数据、
接口路径与响应字段保持不变；`GET /api/operations` 的每行额外带 `batch_id`（单条登记为 `null`）。
