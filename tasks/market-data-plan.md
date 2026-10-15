# Base / Robinhood 行情数据修复计划

日期：2026-10-15（Asia/Shanghai）

状态：Run 5 已修复 Round 2 C3/B1 与 R2-1–R2-5，本地检查见交付记录；浏览器复验待本轮提交后执行。H1 将两链普通 holders 明确降级为暂不提供。生产 Demo secret、登记 Base 正向样本、Robinhood 非空/长历史 trades 与独立复审/发布验收仍未满足；不宣称生产恢复。

## 目标与完成条件

让 Base（8453）和普通 Robinhood（4663）代币的首页、详情页使用经过身份校验的真实行情、K 线和成交数据；两链普通持有人按 H1 暂不提供并明确展示不可用。已有交易但数据源未覆盖、数据请求失败、索引返回空记录、经链上核验无成交，必须分别展示；不能靠隐藏错误提示或填零宣称修复。

完成条件：

1. 两条链 summary/candles/trades 均有实际可用的数据路径；holders 按 H1 稳定返回不可用，来源、时间及覆盖范围可追溯；单项失败不影响其他数据或链上报价。
2. 用真实已有成交的登记池验证正常数据分支；用原报错池验证其当时真实状态。没有正向样本或依赖未满足时，该项不得标为完成。
3. 首页和详情页采用一致的指标语义与快照；缺失字段保留 `null`，实际零值保留 `0`，空历史不生成蜡烛。
4. MUSEGOD 专用行情、六种图表周期、现有交易与费用流程通过相关回归。
5. 本地验收与发布验收分别记录；未发布只能报告本地修复完成。

## 当前证据与样本

2026-10-15 18:18:46 北京时间重新请求生产接口，结果仍复现。以下属于 API 实测，不是链上成交结论。

| 网络 / 样本 | summary | candles（1h） | trades | holders |
| --- | --- | --- | --- | --- |
| Robinhood / MuseVader | 503，功能未接入 | 200，Bankr，`candles: []` | 503，功能未接入 | 503，功能未接入 |
| Base / Musegod–NVDAc | 503，无有效快照 | 503，无有效快照 | 503，无有效快照 | 503，无有效快照 |

- Robinhood token：`0xB60E817D8E6F72013701aC447fd1D92Caa561c7c`；pool：`0x3d20d8f4037cf3a75236fccde9ee33da848ccb14fda4c4dd8367966379b97955`。
- Base token：`0x79eA556198C33BB3025f0243144E74Cb9416E670`；pool：`0x1a050a8dd375dce8c34ae2394aea4c7f0acd1381f29d1290272a5c847cd41475`。它与 Robinhood 的推荐 MUSEGOD 不是同一链上资产。
- 10 月 14 日的 RPC 扫描，仅证明 MuseVader 登记池在区块 `87043468–88137451` 未发现 Swap；不得沿用为今日或其他池的无成交结论。
- Base 四条路径已实现；CoinGecko 的密钥缺失、额度、限流、索引、身份校验等失败被 `server/snapshots.ts` 合并为通用错误，当前精确原因仍待定位。

## 范围与约束

- 复用 `server/market.ts`、`server/snapshots.ts`、现有存储、批量摘要和前端市场组件，不引入通用数据平台。
- 保留 `server/musegod-market.ts` 的固定身份、专用缓存和一分钟刷新行为。
- 不改合约、发行规则、费率、回购、钱包签名及交易入口；不改公开 RPC allowlist 或主 RPC 安全限制。
- `server/alchemy-rpc.ts` 当前将单次 `eth_getLogs` 限制为最多 10 个区块。不能通过切换备用主 RPC、提高此限制或大量十区块请求，绕开现有权限和用量约束。
- 默认不购买付费 API、不增加后台采集常驻进程、不做全链索引。只有取证证明必要时，另列数据依赖方案及成本；依赖解决前不宣称完整恢复。
- 实施时使用独立分支 `codex/market-data-reliability`，先检查并复用合适的已附加工作区。保护其他任务。
- 不加载真实 `.env`，不启动会写生产库的开发服务。验证采用隔离存储、受控只读 API 代理或原生 Worker 测试；凭据不进浏览器、日志或 Git。
- Run 1 仅授权 P1；Run 2 brief 的指挥者裁定另行授权 P2/P3/P5 实施、P4 评估和 P6 本地验证及本地提交。浏览器、review 和发布验收仍留后续；推送、生产配置修改、部署、采集器和购买仍禁止。

## 实施顺序

### P1：定位 Base 真实失败原因，确认两链的数据源覆盖

涉及：`server/market.ts`、`server/snapshots.ts`、`server/config.ts`、现有只读验收脚本。

- [x] 给当前生产版本建立只读基线：按 chain / token / pool / section 记录响应、来源、抓取时间和失败原因，覆盖原报错样本。Run 1 覆盖全部 4 个普通登记代币、六周期及两链 batch，见交付记录。
- [x] 在实际运行环境核验 CoinGecko 凭据是否可用、鉴权类型、剩余额度和上游状态；仅记录布尔结果及脱敏状态，不读取或输出凭据内容。Run 1 已核对 Worker secret 名称（缺少 Demo key）、唯一一次 quota 只读 GET 和本机 Demo 响应；Demo 供应商剩余额度接口返回 401，实际剩余额度仍未知，本机 key 不等于 Worker key。
- [x] 在 Worker 实际出站环境检查 Blockscout，而非把本机 403 直接当成 Worker 的失败原因。Run 1 用无绑定、无 secret、无路由的隔离 remote-dev Worker 单次请求 Base holders，得到 403 challenge；这不是生产 Worker 或 Robinhood 出站验证。
- [ ] 为两链各选择一个已有真实成交的登记池，以及一个空历史样本。不得为验收主动发币或制造交易。
- [ ] 验证 CoinGecko / GeckoTerminal 的 pool summary、OHLCV、trades，以及 Bankr 的对应能力。逐项确认 chain、完整 token、pool、quote、币对方向和返回粒度。
- [x] 持有人来源已按 H1 收口为暂不提供；本轮不接入供应商。今后恢复须重新验证目标 token 的真实覆盖，不能以文档链支持代替。
- [ ] 对有成交证据却没有 USD K 线的池，以同一 token / pool 比较 USD 与 quote 计价响应，判断是否缺少美元估值。quote 数据只用于诊断，不能直接装入 USD 图表。

阶段门：记录每个 section 的主源、可验证备用源和剩余缺口。Base 精确故障必须得到配置、额度或实际上游响应证据；不能继续仅列几种猜测。若原始原因已被吞且无法只读取得，先实施 P2 的最小诊断改动，再回到此步骤定位；定位前不盲目改鉴权或供应商。无法取得运行环境证据时，明确为待验证依赖。

### P2：保留可诊断的错误，修复 Base 数据路径

涉及：`server/market.ts`、`server/snapshots.ts`、`src/lib/market.ts`、`server/app.ts`。

- [x] 在现有错误与快照元数据上补充稳定、脱敏的原因码，至少区分配置缺失、额度不足、未索引、限流、请求失败、身份/数据校验失败。保留已有 fresh / stale / unavailable 语义，不重做接口协议。
- [ ] 根据 P1 证据修复 Base 的实际根因。Run 2 已完成原因保留；缺失的 Worker Demo secret 仍待另行授权配置，不能勾选为生产修复。
- [ ] 仅在 P1 验证可用后，为 Base summary / candles / trades 增加 GeckoTerminal 回退；按错误类型触发，不做无界重试。CoinGecko 和 GeckoTerminal 可能共享索引，回退不代表独立索引保障。
- [x] 保留已有真实零值与合法空结果；全空字段不得当作“行情已恢复”的正向验收证据。请求失败不能转换为成功的空数组。
- [x] H1：holders 不访问任何上游或快照，注册校验后返回 `503 / unavailable / source_not_provided`；历史快照保留不读，MUSEGOD 不受影响。
- [x] 批量摘要保留逐行状态和原因；HTTP 200 不代表每个代币都有有效行情。

阶段门：Base 原故障得到解释；有成交样本能返回真实行情、六周期 K 线和成交，holders 按 H1 明确不可用，不再要求本轮接入来源。尚未解决的外部覆盖问题进入 P4，不能仅靠修改文案结项。

### P3：补齐普通 Robinhood 行情、成交；持有人按 H1 降级

涉及：`server/market.ts`、`server/app.ts`、`src/lib/market.ts`、相关解析测试。

- [x] 增加明确的 Robinhood 分支，按链选择端点与身份前缀；不能只删除 `assertLive()` 后继续访问 Base 数据。
- [ ] summary / trades 采用 P1 验证通过的登记池来源；Run 2 已接入 CoinGecko 精确池，R3 summary 非空、当前 24h trades 合法空，仍缺 Robinhood 非空 trade 列表验收；不将 canary 回执替代该供应商响应。
- [x] H1：holders 保留路由与登记 token 校验，随后直接不可用；删除 Blockscout 抓取/解析、来源推断与失效类型、前端请求/表格、脚本旧校验。
- [x] 不提供持有人总数/Top10/合约标识/更新时间，不填零或伪造；首页原本无持有人区域，无需新增。
- [x] 正反向池统一以 meme token 为展示视角。USD 价格不能简单取倒数；市值、FDV、涨跌和买卖数缺少目标 token 对应字段时保持 `null`。
- [x] candles 优先按完整 token 地址请求，并核对实际计价和方向。Run 3 顺序为 Bankr → GT → CoinGecko，每源最多一次；Bankr 合法空不调用 CG，GT 至少 15 分钟熔断，CG 受 candles 子额度约束；保留 OHLC、时间、去重校验，不填补人工蜡烛。
- [ ] trades 按 from/to 地址确定方向，显式或按供应商 id 推断 logIndex 时用 chain/hash/logIndex 去重；未知格式退回 chain/hash/provider-id。id 段尚未用回执核实，RH 同构格式仅 fixture。8/18 位 fixture 已完成，非登记 Base 真实 11 条归一化 trade 通过；Robinhood 非空 trade 列表仍缺真实验收，故保留未勾选。没有新增原始整数金额通道，Demo 已归一化金额不再缩放。

阶段门：普通 Robinhood 三项功能有真实数据路径；原 MuseVader 即使仍无索引记录，也不能继续收到“整条链功能未配置”的固定错误。没有正向样本不能证明新接入成功。

### P4：收口供应商无法覆盖的缺口

此阶段按实际缺口触发，不预先建设 indexer，也不能跳过未解决项后宣称完成。下列采集方案仅是设计与可行性检查；新增采集器、常驻任务、付费服务或运行权限需要另行明确授权。

- [x] 若免费/现有持有人来源不能覆盖，先比较可用的托管 API。CoinGecko Pro top_holders 文档列出 Base 与 Robinhood，但需 Pro 鉴权且处于 Beta；须验证目标 token、更新频率、金额单位和实际套餐权限后再提出成本选择，不能默认已有权限。
- [x] 若已证明存在链上成交，而所有已验证供应商仍缺失历史，提出范围仅限本站登记池的采集方案：固定起始块、持久游标、重组回退、幂等事件键、每轮/每日请求上限和恢复办法。
- [x] 独立采集方案必须先证明在现有 Alchemy 限制与预算内可行；否则将服务等级或架构调整作为明确依赖，不能偷偷放宽主 RPC 限制或开放浏览器扫链。
- [x] 若持有人改用 Transfer 重建，必须覆盖完整历史、mint/burn 并核对同一参考块的余额和供应量。部分扫描不能声称总持有人数或全局 Top 10。
- [x] 链上读只能生成可证明的量。没有同期可靠 USD 参考时，不能用今日价格或开盘估值生成历史美元成交量、市值或 K 线；未证实字段继续 `null`。
- [x] 不把 v4 PoolManager 的共享代币余额或 active liquidity 当作单池 TVL；不把 router / Swap sender 当作真实最终交易者。市值与 FDV 保持各自供应量口径。

阶段门：每个缺口都有经验证的数据来源，或清楚列明待解决依赖及剩余工作。只有提示诚实但数据依赖未解决，属于降级改善，不是完整修复。

#### Run 2 / P4 评估（2026-10-15；没有购买、接入新服务或建设采集器）

| 缺口 / 选项 | 影响与成本 | 推荐及收敛条件 |
| --- | --- | --- |
| Blockscout PRO API 免费 key | 通用官方文档列免费 100K credits/day、5 RPS，无信用卡；服务器端 `proapi_` key，经 `https://api.blockscout.com/{chain_id}/api/v2/...` 访问。Base 专页却明确列从 Builder $49/月开始，文档存在套餐口径差异。Robinhood 专页明确列 4663 与免费档，但本轮无 key、未验证目标 token | 优先由人类确认免费档的两链实际权限，再用每链一个完整 token 的 info/holders 验证总数、Top10、金额单位、合约标识、更新时间。文档链支持不能代替目标覆盖。H1 已否决本轮接入；Blockscout 行情抓取与解析代码已删除，不新增配置或供应商抽象 |
| CoinGecko Analyst holders / 长历史 trades | Run 1 Demo 对 holders 与 30d trades 返回 401；Analyst 标价 $129/月，年付折合 $103.2/月，目标实际覆盖仍未知 | 先让供应商核对目标 token/pool 与全部所需字段，不购买，不假定套餐升级必然补齐。holders 已由 H1 裁定暂不提供 |
| 暂不提供 holders（H1 已裁定并落实） | 订阅成本 $0；总数、Top10、合约标识与索引时间均不可用；不注册 PRO、不购买 Analyst、不建 Transfer 索引 | `server/market.ts` 直接返回 `source_not_provided`；`TokenMarket.tsx` 静态不可用、无请求；脚本接受该明确 503 契约；旧快照保留不读。恢复必须重新取证，不将降级视为数据恢复 |
| Base 登记池 B1 正向样本 | 原池索引仍为空/核心值 null；非登记 KAI/NVDAc 的非空解析仅验证代码，对登记池验收贡献为零 | 不制造成交。等待原池可追溯的已有 Swap hash 或自然历史；再用获准只读通道抽查。缺 secret 的生产阻断另列发布步骤 |
| R3 长历史 trades | 已独立验证 10 月 8 日历史 canary 的精确池 Swap；免费端点默认 24h 空列表不覆盖该历史。六周期蜡烛可用不等于 trade 列表有长历史 | 先决定产品需要最近索引还是完整历史。保留覆盖限制；不把 24h 空数组当作从未交易 |
| 仅登记池采集设计 | 若从 R3 首笔已知 Swap 块 83223147 到约 88M 块回补，仅 10 区块/请求需约 50 万请求；20 次取证预算不可行，且尚无原池完整起点。未测服务成本，不能给虚假报价 | 暂不建设。候选设计仅固定登记池与已证明起点，持久游标、幂等 chain/txHash/logIndex、参考块哈希、重组回退到最后已确认游标、每轮/每日固定预算、失败续跑。须先证明现有 Alchemy 权限预算可行；不能提高公开 RPC 限制、换主 RPC 或让浏览器扫链 |
| Transfer 重建 / 历史 USD | 部分 Transfer 或共享 PoolManager 余额不能给全局持有人数/单池 TVL；没有同期 USD 参考不能重建美元蜡烛 | 若另获准设计，要求完整 mint/burn/Transfer 历史、同一参考块余额与 supply 核对；缺美元参考继续 null。sender/router 只称交易发送者，不推断最终交易者 |

官方来源（文档快照，不是目标实测）：[PRO 通用免费档](https://docs.blockscout.com/devs/pro-api)、[PRO 鉴权及路由](https://docs.blockscout.com/devs/pro-api-responses-and-routes)、[Base 套餐](https://docs.blockscout.com/base-api)、[Robinhood 支持说明](https://docs.blockscout.com/robinhood-api)、[CoinGecko holders](https://docs.coingecko.com/reference/top-token-holders-token-address)、[CoinGecko 价格](https://www.coingecko.com/en/api/pricing)。本轮只评估，未向供应商发送凭据、创建账号或新增任何常驻流程。

### P5：统一首页与详情页状态、来源、时间和缓存

涉及：`src/components/TokenMarket.tsx`、`src/components/TokenCard.tsx`、`src/lib/token-card-market.ts`、`src/lib/market.ts`、`server/market.ts`、`server/snapshots.ts`。

- [x] 首页普通 Robinhood 卡片接入已实现的批量摘要路径，避免逐卡重复请求；首页与详情页同一指标复用同一快照。
- [x] 分别展示加载中、索引未返回记录、未索引、请求不可用、旧快照。只有明确范围的链上核验支持时才说“没有链上成交”；空数组只说当前索引/周期没有记录。
- [x] summary、candles、trades 使用各自真实 source 与 fetchedAt；holders 静态不可用。首页说明栏不再固定 CoinGecko 或借用 MUSEGOD 时间，配置未到时独立显示 loading；Run 5 补齐默认列表每行可见状态/来源/抓取时间，并按实际显示来源提供 CoinGecko API 署名链接，详情页同样署名（C3/B1 修正此前仅网格成立的勾选）。抓取时间不冒充最后成交时间，刷新失败不把旧数据时间改成现在。
- [x] 保留共享 15 分钟快照、最多 24 小时旧快照的现有边界。新缓存身份包含链/模式、token、pool、quote、section、interval；解析语义变化隔离不再可信的旧键，不删除历史记录。
- [x] 缓存命中不消耗外部额度；同请求合并、限制并发与回退次数、按需加载周期、持有人无请求、尊重限流退避。扩展首页后不得形成 N+1 请求或多实例绕过预算。
- [x] 一个 section、代币或链失败不清空其他有效数据；切链、换池、请求晚到及 fork 均不得串数据。
- [x] 产品提示使用英文，只说明用户需要知道的数据状态；具体内部故障保留在脱敏诊断中。

### P6：验证、文档同步与后续发布

- [x] 为新增行为先建立有意义的失败用例，再修复。扩展现有 market / robinhood-market / worker-market / token-market-network / token-card-market 测试，不复制实现写断言。
- [x] 覆盖矩阵：两链、正反向池、8/18 位 quote、token 与 pool 粒度、错误身份、真实零/null/空数组、401/403/404/429/超时、部分字段、Bankr/GT/CG 失败后回退、空回退不覆盖非空快照、聚合原因、GT 熔断与本地 backoff、candles 子额度、存储/程序错误、provider id 解码/未知格式、旧快照和过期、并发及跨链缓存。
- [x] 验证 MUSEGOD 独立路由、固定身份、专用缓存、一分钟刷新及 FDV 未知语义；不因普通代币接入而覆盖此路径。
- [x] 先跑受影响测试，再跑 `npm test`、`npm run build` 和 `git diff --check`。Worker 出站、JSON/redirect/timeout 行为须有原生 Worker 边界验证。
- [x] 调整现有只读验收脚本：显式接受 chain / token / pool，支持真实空历史，区分 fixture、真实 API 和链上证据；不能强制首个代币必须有交易，也不能用 skip 冒充通过。直接运行，不通过会加载真实 `.env` 的 wrapper。
- [ ] 浏览器验收首页和详情页，包含桌面/390px、浅色/深色、切链、六周期、成交筛选、持有人切换、旧快照及故障恢复。既有数据与受控故障 fixture 分别标识；无需连接或签署真实钱包。
- [x] 在本计划勾选实施结果，同时更新 `docs/SPEC.md` 和必要的 README，移除已被实现替代的“普通 Robinhood 不支持”描述；保留仍真实存在的限制。
- [x] Round 1 独立 reviewer 只读审查已完成；Run 3 fixer 核实 C1–C11 并修复，不改 RPC 或运行时权限。
- [ ] 修复后独立 reviewer 复审仍留下一轮，不能以 fixer 自检冒充独立验收。
- [ ] 后续获准发布时，先记录两个域名当前 release / source / Worker 版本与两链运行控制，再按既有流水线发布；`musegod.fun`、`www.musegod.fun` 的构建身份、实际 API 和浏览器均通过才标记生产完成。
- [ ] 回滚点为发布前实际记录的 Worker / immutable build。回滚后核验两域名、两链 API、数据状态和原有运行控制；不得恢复已被判为错链/错池的旧缓存。代码回滚不自动回退生产配置。

## 交付记录

实施时在此文件记录每阶段结论和证据路径，不再另写第二份规格。供应商探针和 API 响应摘要保留最小必要的脱敏记录；Run 2 修改业务代码和本地验收脚本，未改生产配置、部署或运行权限。

### Run 1 / P1：2026-10-15，只读取证；阶段门未通过

范围依据：`.superpowers/sdd/market-data-reliability/brief-common.md` 与 `run1-brief.md`。报告：`.superpowers/sdd/market-data-reliability/run1-report.md`；以下证据均位于该目录的 `evidence/`，为 gitignored 本地协作产物，不是第二份规格。

**生产基线（已观察事实）**：完整目录为 Base 1 个、Robinhood 3 个普通代币，包含隐藏的 Base Musegod；对每个代币一次读取 summary、六周期 candles、trades、holders，并对每链读取一次 batch。36 个详情中 12 个 HTTP 200 均为空 K 线，24 个 HTTP 503；Base batch HTTP 200 但唯一行 `summary:null,status:unavailable`，Robinhood batch HTTP 503。全部 token/pool/quote、source/fetchedAt/status/错误与原始响应见 `catalog-*.json`、`production-baseline.json`、`production-*.json`，不能用 HTTP 200 或空数组认定修复成功。

**Base 原因（配置事实与同版本复现）**：`worker-secret.json` 中没有 `COINGECKO_API_KEY`，提交中的 vars 同样未配置；活动版本 `27772523-6fde-4b12-972c-e4c84f5f8d52` 的 source tag 为 `57624e9ec193fb15f53d264efe9a0cff7af090cb`。现有 `MarketReader` 缺 key 时先于 quota / fetch 失败，原始原因 `The CoinGecko Demo API key is not configured` 被 Snapshots 吞掉；`missing-key-local-reproduction.json` 在无网络、无生产存储的隔离复现中确认这一顺序。未读取实际 Worker secret 或活动明文 vars 值，也未捕获生产未掩盖异常；结论依据为 secret 配置证据、部署 source、提交中的 vars 与同版本复现。

**鉴权、额度与上游（已观察事实）**：本机 Demo key 配置存在，原 Base 池 summary/trades/1h USD/1d USD/1h quote 均返回 200 并通过现有解析器，32 字节 v4 pool 身份、meme18/quote8 位元数据正确。但核心行情为 null、交易和蜡烛为空，不能当正向样本。唯一 Supabase quota GET 返回 `rows:[]`，未观察到当日/月达到 300/9000 上限；本机 URL 与提交中的 Worker URL 相同，但不是独立读取活动 Worker 变量的证据。Demo `/key` 返回 401/10005，不知道供应商剩余额度。本机 key 不一定等于 Worker secret。见 `cg-8453-MUSEGOD-*.json`、`supabase-quota-single-read.json`、`supabase-project-binding.json`、`cg-key-usage.json`。本轮未调用额度 RPC。

**持有人与 Worker 边界（已观察事实）**：Base、Robinhood 的抽样 Blockscout token/holders 本机请求均 403 challenge；无绑定临时 Cloudflare remote-dev Worker 对 Base holders 的一次实际出站也为 403 HTML challenge。没有将该探针当作生产 Worker 或 Robinhood Worker 的结果。CoinGecko Demo 对两链目标 token 的 top_holders 返回 401，明确要求 Analyst 或以上；没有任何真实持有人正向响应。见 `blockscout-local-*.json`、`blockscout-worker-egress.json`、`egress-probe-persistence-check.json`、`cg-*-holders.json`。补 Demo secret 不会自动解决 holders。

**样本、身份与覆盖（事实及未完成项）**：

- Base 目录只有原 Musegod/NVDAc 池；USD/quote K 线及 trades 均空，**无正向样本**。该池可作索引空历史样本，不能称链上无成交。
- Robinhood MV2C 的 CoinGecko 精确 pool summary 有 price/FDV/liquidity（市值 null），1h USD 两根、1d 一根、quote 两根；24h trades 为空，30d 查询 401。尚无带成交 hash 且独立抽查的完整正向样本，不将发行/收费/结算 hash 冒充 Swap。MuseVader/CLAWGOD 可作索引空历史样本；不外推 10 月 14 日旧扫描。
- 实测 CoinGecko network id 为 `base` / `robinhood`；MuseVader 的 summary 为反向池，另两个 RH 池正向。现有 summary parser 硬编码 `base_`，直接套用到 RH 会拒绝身份；完整 token 参数的 RH candles 可通过身份解析。实际 decimals：Base meme18/NVDAc8，RH meme18/MUSEGOD18、WETH18、COST18。
- Bankr 的目标 discovery/stats/swaps 均 404（含规范小写、无 chain 的既有路径复核）；MuseVader/CLAWGOD chart 是有身份的合法空；MV2C chart 仅 `{ohlcv:[]}`、缺 pool/pair，现有 parser 拒绝。不能直接套用专用 MUSEGOD 的 summary/trades 逻辑。
- GeckoTerminal 本机多次无 HTTP 传输失败，curl TLS 失败，web 亦不可达，已停止该策略；尚未对 RH 各 section 或持有人完成实测，**无已验证备用源**。没有把 CoinGecko 共享索引当作 GT 可达性证据。
- USD/quote 对照中，Base/MuseVader/CLAWGOD 两者均空；MV2C 两者均非空、时间匹配。没有找到“已独立证明成交、quote 有记录而 USD 为空”的合格样本，不能判定缺 USD 估值。以上缺口对应 P1 未勾选条目。

**阶段门（各项均未通过）**：

| 链 / section | 主源或候选 | 已验证备用源 | 剩余缺口 |
| --- | --- | --- | --- |
| Base summary | CoinGecko（空核心行情可解析） | 无 | Worker Demo secret、非空正向样本 |
| Base candles | CoinGecko（1h/1d合法空） | 无 | Worker secret、真实非空周期、GT可达性 |
| Base trades | CoinGecko（24h合法空） | 无 | Worker secret、已有成交hash与独立回执、历史覆盖 |
| Base holders | 现有 Blockscout 已实测失败 | 无 | Worker403；Demo top_holders401；数据来源决策 |
| Robinhood summary | 候选 CoinGecko（MV2C非空） | 无 | 链前缀/反向身份、Worker鉴权/共享预算、完整成交样本 |
| Robinhood candles | 既有 Bankr→GT；候选CG有MV2C非空1h/1d | 无非空备用源 | Bankr缺身份；GT未验证；新增CG路径须另定范围并补六周期验证 |
| Robinhood trades | 候选CG仅验证24h空；Bankr目标404 | 无 | 正向交易、独立回执、较长历史访问条件 |
| Robinhood holders | 无可用主源 | 无 | 本机403、RH Worker出站待验证、Demo401、目标覆盖未知 |

**待决策及 Run 2 边界**：将 Worker key 配置留作后续明确授权的发布步骤，本轮禁止 secret put/部署。持有人可先核验托管 API 目标完整 token、总数/合约标识/更新时间/单位；Analyst 官方月付标价 $129（年付折合 $103.2/月），实际目标覆盖未知，不能直接购买或默认需要 Pro。补齐允许的现有 Alchemy 只读凭据通道或可追溯的已有成交记录后，在 ≤20 次请求内抽查，不制造交易、不扩大日志范围、不自建索引。Run 2 可由指挥者先明确安排原因保留、RH身份解析和P5状态改善；在来源和样本门未满足前，不新增未验证回退、不宣称完整恢复。具体文件、端点、身份规则和有限回退条件见 Run 1 报告；本轮没有进入 P2/P3/P5。

**本地验证与交付**：`npm test` 1464/1464 通过（0 skipped、0 todo）；`npm run build`（两套 TypeScript 检查及 Vite 构建）通过，仅有既存大 chunk 提示；`git diff --check` 与暂存区 diff 检查通过。脱敏扫描与本地提交信息见本轮最终报告及 `evidence/local-validation.json`。仅提交本计划，不推送、不部署；源文件、交易流程、MUSEGOD专用语义和运行权限均未改动，回滚只涉及撤销本轮计划文件提交，不改变生产状态。

官方能力参考（文档核验于 2026-10-15，不等于目标池实测通过）：

- [CoinGecko Pool OHLCV：目标 token、USD/quote 计价、空周期行为](https://docs.coingecko.com/demo/reference/pool-ohlcv-contract-address)
- [CoinGecko Pro Top Holders：Base / Robinhood 支持与 Beta、鉴权限制](https://docs.coingecko.com/reference/top-token-holders-token-address)

### Run 2 / P2: local diagnostic implementation

Authority: Run 2 commander's decisions supersede the Run 1 implementation hold; production configuration and deployment remain prohibited. `server/market.ts`, `snapshots.ts`, `app.ts`, and `src/lib/market.ts` preserve stable sanitized reasons and HTTP status in unavailable/stale/batch responses. No provider body or private URL is exposed. Retry suppression retains the cause; 429 honors Retry-After and snapshot TTL.

Evidence under `.superpowers/sdd/market-data-reliability/evidence/`: `run2-p2-red.log` demonstrates two failing new tests before implementation; `run2-p2-test.log` passes 1466/1466 (zero skips/todos); `run2-p2-build.log` passes both TypeScript targets and Vite. `git diff --check` passes. MUSEGOD source remains unchanged.

`run2-gt-worker-egress.json`: four unbound remote-dev GETs (R3 summary/hour/trades and B1 summary) all returned HTTP 429. GT identity/nonempty coverage remains unverified; no new Base fallback is implemented. Production Demo secret and holders source remain dependencies; this stage is a diagnostic improvement, not restored production data.

### Run 2 / P3: explicit Robinhood data paths

`server/market.ts` selects CoinGecko network/prefix `base` or `robinhood` and the matching Blockscout host. Reverse summaries use only `quote_token_price_usd` for the target meme token; FDV/market cap/change/buy/sell counts remain null because those fields describe the provider base asset. Pool liquidity and USD volume remain pool-level values. No count inversion is assumed.

Historical Run 2 order was CoinGecko -> Bankr -> GT. Round 1 found quota starvation and empty-fallback snapshot corruption; this order is superseded by Run 3 Bankr -> GT -> CG and the candles subquota described below. The recorded R3 six-interval observations remain historical source evidence, not a guarantee of Worker availability. No Base GT fallback or production quota RPC was used.

Trade side derives from exact from/to addresses. Demo amounts are already normalized human units and are never scaled again. Run 2 inferred the logIndex segment from observed Base network/block/hash/segment/timestamp ids, without receipt verification. Run 3 retains explicit/inferred chain/hash/logIndex keys and falls back to opaque chain/hash/provider-id for unknown formats. Robinhood same-shape ids are controlled fixtures only; real nonempty RH ids remain unobserved. Fixture precision coverage is distinct from real supply/holder coverage.

TDD evidence: `run2-p3-red.log`, `run2-p3-trades-red.log`, `run2-p3-target.log`; full `run2-p3-test.log` 1469/1469 (zero skips/todos), `run2-p3-build.log` both TypeScript targets + Vite, diff check passed. `run2-r3-swap-proof.json` independently verifies Oct 8 exact-pool Swap receipts in two historical canary transactions, using 7 direct Alchemy reads including receipt/block timestamps, no logs scan. Candidate hashes came from the existing local canary journal. Its current digest differs from the tracked historical journal digest, so it is only a candidate locator; independent Alchemy receipts, manager/pool topics and canonical block timestamps are the evidence. These are historical canary test trades, not organic demand.

`run2-base-parser-proof.json`: nonregistered Base v4 KAI/NVDAc 18/8 pool has nonempty summary/trades. The 200-row hourly response contains conflicting duplicates and correctly fails closed; the same exact-token 30-row query passes (`run2-base-candles-30.json`). This is parser evidence only; registered B1 remains without a positive sample. Real raw evidence is retained, not trimmed into a fake successful response. Two-chain holders still have no verified positive source, and long-history trades/production credentials remain dependencies.

### Run 2 / P5 + P6 local: homepage, provenance, cache identity and acceptance

`src/lib/token-card-market.ts`, `src/App.tsx`, `TokenCard.tsx` and `TokenMarket.tsx` now use registered-address batches on both mainnets, retain independent per-row failures, and show each section's real source/fetch time. Chart attribution never borrows summary time, and trades no longer hard-code CoinGecko. Loading has no assumed provider. Empty history only describes indexed records; transaction sender is not claimed to be the final trader. `src/lib/api.ts` retains sanitized reasons for state messages; `server/app.ts` includes Retry-After so HTTP clients do not immediately retry known failures.

The shared `market:v2` cache identity binds deployment chain/mode, complete token, pool, quote, section and candle interval. Both summary routes share the same key. Old keys are retained and isolated; no history deletion or migration occurs. Frontend scope/key changes and the existing request cancellation guard prevent reuse after chain, pool, quote or period changes. 15-minute fresh / 24-hour stale and actual snapshot timestamps remain; MUSEGOD server source, dedicated keys and one-minute TTL are unchanged.

TDD logs: `run2-p5-red.log`, `run2-p5-source-red.log`, `run2-p5-batch-red.log`, `run2-http-red.log`, `run2-worker-timeout-red.log`. Native Workerd checks use controlled fixture upstreams, including manual redirects, JSON rejection, 429 backoff and injected timeout; they are not live provider evidence. The direct HTTP script explicitly accepts origin/chain/token/pool/evidence/output, loads no dotenv, records legal empty histories as contract observations, and exits incomplete for failed dependencies rather than skipping. `package.json` no longer wraps this script with `scripts/run.ts`. `docs/SPEC.md` and README now describe implemented RH paths and remaining dependencies.

P4 evaluation is recorded above. H1 now closes the holders product decision as intentionally unavailable; Base registered positive data, long-history trades and any future collector remain unresolved. Browser, post-fix independent review and publication gates remain unchecked for later runs.

Quota estimate (Run 3 supersedes Run 2): 当前目录 Base 1 池、RH 3 池，两链首页冷缓存为 `ceil(1/30)+ceil(3/30)=2` 次 CG multi / 15 分钟，持续使用需求为 192/天。MUSEGOD 不消耗 Demo；普通 batch 现在独立每 15 分钟刷新，卡片列表变化不整体清空快照。

按已观察来源形态（R1/R2 Bankr 有身份合法空，GT 不提供非空；R3 Bankr 缺身份、GT 失败；Base 仅 CG），四池六周期需要 `6*(Base+R3)=12` 次 CG，trades 4 次：首页已预取时合计 18 次/周期（需求 1728/天），四详情各自冷启动单摘要时合计 20 次。R1/R2 每个周期不调用 CG；R3 的 CG 必须先通过 candles 子额度。若所有 RH 的 Bankr/GT 都失败，最坏需求为 24 candles + 4 trades + 2 首页 multi = 30/周期（2880/天）；详情单摘要冷启动为 32。多实例、重启及地址组变化可能额外 miss；实际全站上界仍由持久共享预算 300/天、9000/月约束。

所有链 candles 的 CG 调用先 reserve `<shared scope>:candles`（当前 `base:candles`）100/天、3000/月，再 reserve 原 `base` 共享预算。现有 text scope 与 RPC 支持子 scope，不新增迁移；Supabase 两链共用 `base:candles`，SQLite 用日期 key 后缀隔离子额度。candles 最多占共享 100/天、3000/月，因此 summary/trades 合计至少保有 200/天、6000/月的容量；这不是每项请求都能成功或单独保留给 summary 的保证。缓存命中不扣额度，同键并发合并。子额度先扣使已耗尽 candles 不消耗 summary/trades 的共享容量；若之后共享扣额失败，已扣的一次子额度会浪费。不新增退款/迁移，未发上游请求，不误称一次跨 scope 原子操作。反过来先扣共享会在子额度耗尽后持续浪费有限的共享容量，所以不采用。GT 429 或 503 + Retry-After 在本实例至少熔断 15 分钟，成功响应忽略该头，不对每个 key 白发请求；重启/多实例不是全局 GT 熔断。

Local rollback: revert the Run 2 commits in reverse order on this branch; production is unchanged. Reverting code alone does not delete new/old snapshots or change future secret/configuration state. Any later rollout must capture its actual production rollback point and honor the separate release gate.

Final local validation: `run2-final-test.log` passes 1479/1479, zero skipped/todo/cancelled; `run2-final-build.log` passes both TypeScript targets and Vite (existing large-chunk warning only); `git diff --check` passes. `run2-secret-scan.json` finds zero plaintext matches for the two permitted credentials across Run 2 evidence and the complete diff. `run2-r3-proof-binding.json` binds all target Swap logs to the pinned Robinhood PoolManager; `run2-chain-binding.json` independently confirms chain 4663. `run2-probe-persistence-check.json` confirms the temporary probe resource is absent. Final Run 2 request count: Demo 11 (5 Base, 6 R3 intervals), GT remote-dev 4, Alchemy read-only 8, production Supabase GET/write/quota RPC 0. No browser, push, deployment, signing, production control/configuration or collector change occurred.

Stage commits: P2 `ec1ffe0`, P3 `7579133`, P5/P4/P6 in this final local commit. Full Run 2 report: `.superpowers/sdd/market-data-reliability/run2-report.md`. Historical Run 2 result was NEEDS_DECISION for production secret/holders and positive registered Base/long-history gaps; H1 now settles holders as intentionally unavailable; local implementation and scoped validation are complete, full production restoration is not.


### Run 3：Round 1 findings 与 H1 本地收口

授权：`run3-brief.md` 的指挥者裁定。C1–C11 均已核实并修复，无 disputed/deferred finding；H1 为 owner 明确产品取舍。服务端来源顺序/空回退保护/原因聚合/GT 熔断/100 日 3000 月子额度、未知 USD 占位零处理、provider id 兼容去重、Storage/Internal/backoff 分类已实现。前端来源说明、独立 1/15 分钟刷新、逐行身份保留、MUSEGOD Pools 链接与一分钟提示、刷新不遮挡已有数据、空价格记录文案均修复。H1 删除 holders 上游与缓存、类型/来源推断、前端表格/请求；路由登记校验与长 Retry-After 保留，首页原本无持有人区域。旧 holders 快照不删除、不读取。

TDD 证据：`evidence/run3-server-red.log`（服务端新用例原先失败）、`run3-ui-red.log`（UI/脚本失败）、`run3-card-hook-red.log`（修正测试 harness 后对 Run 2 原源码验证缺少 15 分钟计时器）、`run3-refresh-red.log`（原源码对已有数据显示 loading 横幅）；其余对应 green/target 日志。测试运行仅用隔离 SQLite/受控 Supabase request/受控 fetch/SSR/hook/Workerd fixture；无真实 `.env`、外部 API、Supabase 生产 GET/写入/quota RPC、生产配置或部署。`server/musegod-market.ts`、RPC 限制、合约/交易/发行/费率/回购及运行权限均未改。

具体测试增量、全量检查、提交和回滚见本轮 `run3-report.md`；修复映射已追加到 `claude-review.md` 的「Round 1 fixer 响应」，审查者原文完整保留。后续独立复审、浏览器与生产验收仍未完成，Worker Demo secret、登记 Base 正向样本、真实 RH 非空/长历史 trades 不因本地测试而消失。H1 限制今后恢复须重新取证。


Run 3 最终本地验证：`evidence/run3-final-test.log` **1495/1495**，0 fail/cancelled/skipped/todo（比 Run 2 净增16）；`run3-final-build.log` 两套tsc及Vite通过，仅既有大chunk提示；`git diff --check`通过。初次全量发现共享错误分类影响MUSEGOD来源字段，已在Snapshots保留provider身份并用Internal cause分类，原MUSEGOD测试未改，51项定向回归与全量均通过。`server/musegod-market.ts`等受保护路径对起点无差异。回滚：在本分支核对后续提交后`git revert HEAD`（仅当HEAD为本轮 `fix(market): address reliability review and disable holders` 提交）；不删历史快照/额度记录、无生产配置回滚。最终本地提交信息在本轮报告记录；状态 DONE 仅指Run 3授权范围。


### Run 5：Round 2 修复（浏览器复验前）

授权：`run5-brief.md` 与仍有效的 Run 3 指挥者裁定。C3/B1：列表复用网格的 `CardMarketStatus`，逐行显示实际来源和抓取时间，loading/unavailable/Previous snapshot 直接可见；fresh 的未知指标仍为破折号。首页说明栏按实际出现的 CG 行显示带链接署名，详情各 section 同样署名，网格保留单一详情链接，不嵌套链接。官方署名依据：[attribution guide](https://brand.coingecko.com/resources/attribution-guide)、[API Deck](https://assets.coingecko.com/reports/API/CoinGecko-API-Deck.pdf)，2026-10-15 本轮核对。

R2-1：写快照失败后在 Snapshots 实例内保留本次返回值至该 key 的 TTL，命中先于存储读取，summary/batch 共用；普通15分钟、MUSEGOD一分钟，不重复上游或 quota。非跨实例/重启保障。R2-2：共享 `marketFailure` 分类网络和明确程序异常，未知异常用中性 `upstream_unclassified`；应用装配处给 MUSEGOD 注入带 HTTP 状态的 `marketFetch`。`server/musegod-market.ts` 的源码、固定身份、专用键及一分钟语义均未改。R2-3：只有429或503+Retry-After打开host退避，成功响应忽略该头。R2-4：删除 holders 的 `.market-table .chip` 死样式，保留 API 客户端对 `source_not_provided` 的提示映射，前端仍不请求 holders。

R2-5 已核对现有 SQL：cleanup、backup、restore 均严格按 scope，不包含 `<scope>:candles`（当前 `base:candles`）。子额度日/月行约每月31+1条、每年不超过约384条/共享quota scope，会累积；按主scope恢复不恢复子额度，新的quota scope从0计子额度，共享总额限制仍有效。本轮不改cleanup：量级小，新增迁移和生产写入语义变化不属于本轮必要修复；后续如需运维清理须另行授权。没有执行任何数据库操作。

TDD：`evidence/run5-red.log` 首次75项中8项失败，覆盖缺少列表状态/署名、重复写失败扣额、MUSEGOD分钟保护/HTTP边界、网络分类和成功响应退避。修复后定向98/98通过（包含真实Express路由、SSR与实际hook回归）；全量、build、提交结果及浏览器覆盖在后续记录补齐。

Run 5 浏览器前最终检查：`evidence/run5-final-test.log` 全量 **1502/1502**，0 fail/cancelled/skipped/todo；`run5-final-build.log` 两套tsc+Vite通过（仅既有大chunk提示）；`git diff --check`通过。更正SSR属性名大小写后的测试已在原 `aa0afdd` App 上重新执行，`run5-ui-baseline-red.log` 9项中2项失败，确认仍真实检测缺少逐行状态/来源/时间与错误说明栏，并恢复当前源码。受保护的MUSEGOD专用reader、alchemy-rpc、合约、supabase源码对起点均无差异。浏览器复验与本地提交摘要后补。
