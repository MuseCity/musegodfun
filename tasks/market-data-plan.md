# Base / Robinhood 行情数据修复计划

日期：2026-10-15（Asia/Shanghai）

状态：Run 2 按指挥者裁定实施中；P2 本地诊断改动已验证。完整数据恢复仍受生产 secret、登记 Base 正向样本和 holders 来源限制。

## 目标与完成条件

让 Base（8453）和普通 Robinhood（4663）代币的首页、详情页使用经过身份校验的真实行情、K 线、成交和持有人数据。已有交易但数据源未覆盖、数据请求失败、索引返回空记录、经链上核验无成交，必须分别展示；不能靠隐藏错误提示或填零宣称修复。

完成条件：

1. 两条链的四类接口均有实际可用的数据路径，来源、时间及覆盖范围可追溯；单项失败不影响其他数据或链上报价。
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
- 原计划只授权排查与制定计划；本轮 Run 1 brief 另行明确授权 P1 只读取证、更新本计划和本地提交。此授权不包含 P2–P6 实施、推送、生产配置修改或部署。后续实施与发布必须沿用届时明确授权。

## 实施顺序

### P1：定位 Base 真实失败原因，确认两链的数据源覆盖

涉及：`server/market.ts`、`server/snapshots.ts`、`server/config.ts`、现有只读验收脚本。

- [x] 给当前生产版本建立只读基线：按 chain / token / pool / section 记录响应、来源、抓取时间和失败原因，覆盖原报错样本。Run 1 覆盖全部 4 个普通登记代币、六周期及两链 batch，见交付记录。
- [x] 在实际运行环境核验 CoinGecko 凭据是否可用、鉴权类型、剩余额度和上游状态；仅记录布尔结果及脱敏状态，不读取或输出凭据内容。Run 1 已核对 Worker secret 名称（缺少 Demo key）、唯一一次 quota 只读 GET 和本机 Demo 响应；Demo 供应商剩余额度接口返回 401，实际剩余额度仍未知，本机 key 不等于 Worker key。
- [x] 在 Worker 实际出站环境检查 Blockscout，而非把本机 403 直接当成 Worker 的失败原因。Run 1 用无绑定、无 secret、无路由的隔离 remote-dev Worker 单次请求 Base holders，得到 403 challenge；这不是生产 Worker 或 Robinhood 出站验证。
- [ ] 为两链各选择一个已有真实成交的登记池，以及一个空历史样本。不得为验收主动发币或制造交易。
- [ ] 验证 CoinGecko / GeckoTerminal 的 pool summary、OHLCV、trades，以及 Bankr 的对应能力。逐项确认 chain、完整 token、pool、quote、币对方向和返回粒度。
- [ ] 验证持有人来源的真实覆盖；不能因为文档列出某条链，就认定目标代币已被索引。
- [ ] 对有成交证据却没有 USD K 线的池，以同一 token / pool 比较 USD 与 quote 计价响应，判断是否缺少美元估值。quote 数据只用于诊断，不能直接装入 USD 图表。

阶段门：记录每个 section 的主源、可验证备用源和剩余缺口。Base 精确故障必须得到配置、额度或实际上游响应证据；不能继续仅列几种猜测。若原始原因已被吞且无法只读取得，先实施 P2 的最小诊断改动，再回到此步骤定位；定位前不盲目改鉴权或供应商。无法取得运行环境证据时，明确为待验证依赖。

### P2：保留可诊断的错误，修复 Base 数据路径

涉及：`server/market.ts`、`server/snapshots.ts`、`src/lib/market.ts`、`server/app.ts`。

- [x] 在现有错误与快照元数据上补充稳定、脱敏的原因码，至少区分配置缺失、额度不足、未索引、限流、请求失败、身份/数据校验失败。保留已有 fresh / stale / unavailable 语义，不重做接口协议。
- [ ] 根据 P1 证据修复 Base 的实际根因。生产凭据或配置修改单列到发布步骤，不在代码修复时擅自修改。
- [ ] 仅在 P1 验证可用后，为 Base summary / candles / trades 增加 GeckoTerminal 回退；按错误类型触发，不做无界重试。CoinGecko 和 GeckoTerminal 可能共享索引，回退不代表独立索引保障。
- [ ] 保留已有真实零值与合法空结果；全空字段不得当作“行情已恢复”的正向验收证据。请求失败不能转换为成功的空数组。
- [ ] 持有人独立处理，不因 CoinGecko 行情故障一起失效；Blockscout 失败时仅使用已验证的替代来源。
- [x] 批量摘要保留逐行状态和原因；HTTP 200 不代表每个代币都有有效行情。

阶段门：Base 原故障得到解释；有成交样本能返回真实行情、六周期 K 线和成交，持有人有独立可验证路径。尚未解决的外部覆盖问题进入 P4，不能仅靠修改文案结项。

### P3：补齐普通 Robinhood 行情、成交和持有人

涉及：`server/market.ts`、`server/app.ts`、`src/lib/market.ts`、相关解析测试。

- [ ] 增加明确的 Robinhood 分支，按链选择端点与身份前缀；不能只删除 `assertLive()` 后继续访问 Base 数据。
- [ ] summary / trades 采用 P1 验证通过的登记池来源；Bankr 仅在能证明覆盖目标 pool 时复用。token 级全池聚合不得冒充单一登记池数据。
- [ ] holders 按目标链和 token 校验，与行情数据独立缓存、独立失败。
- [ ] 替代持有人来源若不提供总数、合约标识或更新时间，不能默认为零、普通钱包或当前时间；按现有展示需要保留未知并明确数据范围。
- [ ] 正反向池统一以 meme token 为展示视角。USD 价格不能简单取倒数；市值、FDV、涨跌和买卖数缺少目标 token 对应字段时保持 `null`。
- [ ] candles 优先按完整 token 地址请求，并核对实际计价和方向。保留现有 Bankr → GeckoTerminal 路径及 OHLC、时间、去重校验，不填补人工蜡烛。
- [ ] trades 按 from/to 资产地址推导买卖及数量，按 chain / txHash / logIndex 去重。只对原始整数按各资产 decimals 转换；已归一化金额不得再缩放。覆盖 B20 quote 8 位、meme 18 位和 WETH 18 位。

阶段门：普通 Robinhood 三项功能有真实数据路径；原 MuseVader 即使仍无索引记录，也不能继续收到“整条链功能未配置”的固定错误。没有正向样本不能证明新接入成功。

### P4：收口供应商无法覆盖的缺口

此阶段按实际缺口触发，不预先建设 indexer，也不能跳过未解决项后宣称完成。下列采集方案仅是设计与可行性检查；新增采集器、常驻任务、付费服务或运行权限需要另行明确授权。

- [ ] 若免费/现有持有人来源不能覆盖，先比较可用的托管 API。CoinGecko Pro top_holders 文档列出 Base 与 Robinhood，但需 Pro 鉴权且处于 Beta；须验证目标 token、更新频率、金额单位和实际套餐权限后再提出成本选择，不能默认已有权限。
- [ ] 若已证明存在链上成交，而所有已验证供应商仍缺失历史，提出范围仅限本站登记池的采集方案：固定起始块、持久游标、重组回退、幂等事件键、每轮/每日请求上限和恢复办法。
- [ ] 独立采集方案必须先证明在现有 Alchemy 限制与预算内可行；否则将服务等级或架构调整作为明确依赖，不能偷偷放宽主 RPC 限制或开放浏览器扫链。
- [ ] 若持有人改用 Transfer 重建，必须覆盖完整历史、mint/burn 并核对同一参考块的余额和供应量。部分扫描不能声称总持有人数或全局 Top 10。
- [ ] 链上读只能生成可证明的量。没有同期可靠 USD 参考时，不能用今日价格或开盘估值生成历史美元成交量、市值或 K 线；未证实字段继续 `null`。
- [ ] 不把 v4 PoolManager 的共享代币余额或 active liquidity 当作单池 TVL；不把 router / Swap sender 当作真实最终交易者。市值与 FDV 保持各自供应量口径。

阶段门：每个缺口都有经验证的数据来源，或清楚列明待解决依赖及剩余工作。只有提示诚实但数据依赖未解决，属于降级改善，不是完整修复。

### P5：统一首页与详情页状态、来源、时间和缓存

涉及：`src/components/TokenMarket.tsx`、`src/components/TokenCard.tsx`、`src/lib/token-card-market.ts`、`src/lib/market.ts`、`server/market.ts`、`server/snapshots.ts`。

- [ ] 首页普通 Robinhood 卡片接入已实现的批量摘要路径，避免逐卡重复请求；首页与详情页同一指标复用同一快照。
- [ ] 分别展示加载中、索引未返回记录、未索引、请求不可用、旧快照。只有明确范围的链上核验支持时才说“没有链上成交”；空数组只说当前索引/周期没有记录。
- [ ] summary、candles、trades、holders 使用各自真实 source 与 fetchedAt，去掉成交栏固定 CoinGecko 的归因。抓取时间不冒充最后成交时间，刷新失败不把旧数据时间改成现在。
- [ ] 保留共享 15 分钟快照、最多 24 小时旧快照的现有边界。新缓存身份包含链/模式、token、pool、quote、section、interval；解析语义变化隔离不再可信的旧键，不删除历史记录。
- [ ] 缓存命中不消耗外部额度；同请求合并、限制并发与回退次数、按需加载持有人和周期、尊重限流退避。扩展首页后不得形成 N+1 请求或多实例绕过预算。
- [ ] 一个 section、代币或链失败不清空其他有效数据；切链、换池、请求晚到及 fork 均不得串数据。
- [ ] 产品提示使用英文，只说明用户需要知道的数据状态；具体内部故障保留在脱敏诊断中。

### P6：验证、文档同步与后续发布

- [ ] 为新增行为先建立有意义的失败用例，再修复。扩展现有 market / robinhood-market / worker-market / token-market-network / token-card-market 测试，不复制实现写断言。
- [ ] 覆盖矩阵：两链、正反向池、8/18 位 quote、token 与 pool 粒度、错误身份、真实零/null/空数组、401/403/404/429/超时、部分字段、主源失败后回退、旧快照和过期、并发及跨链缓存。
- [ ] 验证 MUSEGOD 独立路由、固定身份、专用缓存、一分钟刷新及 FDV 未知语义；不因普通代币接入而覆盖此路径。
- [ ] 先跑受影响测试，再跑 `npm test`、`npm run build` 和 `git diff --check`。Worker 出站、JSON/redirect/timeout 行为须有原生 Worker 边界验证。
- [ ] 调整现有只读验收脚本：显式接受 chain / token / pool，支持真实空历史，区分 fixture、真实 API 和链上证据；不能强制首个代币必须有交易，也不能用 skip 冒充通过。直接运行，不通过会加载真实 `.env` 的 wrapper。
- [ ] 浏览器验收首页和详情页，包含桌面/390px、浅色/深色、切链、六周期、成交筛选、持有人切换、旧快照及故障恢复。既有数据与受控故障 fixture 分别标识；无需连接或签署真实钱包。
- [ ] 在本计划勾选实施结果，同时更新 `docs/SPEC.md` 和必要的 README，移除已被实现替代的“普通 Robinhood 不支持”描述；保留仍真实存在的限制。
- [ ] 独立 reviewer 只读审查；fixer 核实后修复，不借审查改变 RPC 或运行时权限。
- [ ] 后续获准发布时，先记录两个域名当前 release / source / Worker 版本与两链运行控制，再按既有流水线发布；`musegod.fun`、`www.musegod.fun` 的构建身份、实际 API 和浏览器均通过才标记生产完成。
- [ ] 回滚点为发布前实际记录的 Worker / immutable build。回滚后核验两域名、两链 API、数据状态和原有运行控制；不得恢复已被判为错链/错池的旧缓存。代码回滚不自动回退生产配置。

## 交付记录

实施时在此文件记录每阶段结论和证据路径，不再另写第二份规格。供应商探针、API 响应摘要和浏览器证据仅保留最小必要的脱敏记录。业务代码、配置、部署和运行权限均未修改。

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
