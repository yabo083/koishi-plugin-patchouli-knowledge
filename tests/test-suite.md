# Patchouli Knowledge - 行为规格表 (L4 Test Suite)

| 用例 ID | 场景描述 | 前置条件 | 操作序列 / 刺激事件 | 预期状态流转与结果 | 底层判定机制 (Why) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **BURST-01** | 常态闲聊不误触 | 群处于 IDLE，基线 2 条/分 | 每 30 秒进入 1 条闲聊消息，持续 10 分钟 | 状态恒为 `IDLE`，缓冲区不累积讨论事件 | 瞬时速率 2 条/分 <= 触发门限，突发比率维持在 1.0 附近 |
| **BURST-02** | 激烈讨论触发录制 | 群处于 IDLE，基线 2 条/分 | 1 分钟内密集涌入 15 条长短观点消息 | 状态由 `IDLE` 转移至 `BURSTING`，开启滑动讨论缓存 | 瞬时速率 15 条/分 > max(6, 2*2.5)=6，满足突发条件 |
| **BURST-03** | 讨论平息度过迟滞期 | 状态处于 `BURSTING`，累计消息 20 条 | 频率骤降至 0~1 条/分，持续 300 秒无次级突发 | 状态由 `BURSTING` -> `COOLING` -> 触发 `SUMMARIZING` | 速率回落且静默观察期满，满足迟智沉淀条件 |
| **BURST-04** | 冷却期次级突发重置 | 状态处于 `COOLING`，已观察 120 秒 | 突然再次涌入 10 条反驳消息（第二波争论） | 状态从 `COOLING` 回退至 `BURSTING`，延长缓存周期 | 次级突发证明争论未结束，避免半途截断上下文 |
| **DISPATCH-01**| 知识提炼与格式化 | 收集到 25 条关于技术选型的激烈争论 | 调度器调用模型处理并解析结构化输出 | 成功生成符合 `WikiEntry` 契约的对象，包含观点碰撞矩阵；同时恒返回 0~1 的 `qualityScore` 与 `discardReason: null` | Prompt 引导提取论点、支持者、反驳与共识；质量分用于 AIMD 闭环 |
| **DISPATCH-02**| 质量信号与运行时失败分离 | 模型返回中文别名舍弃原因 / 输出缺 `qualityScore` / 网络失败 / 会话为空 | 逐类调用 `dispatch` | 主动舍弃 → `discardReason` 归一化为三选一（`NOISE_SPAM`/`LOW_DENSITY`/`FRAGMENTED`）、`failureReason` 缺省；成功 → `qualityScore` 恒存在（缺失/非法按 0.5）；运行时失败 → `qualityScore=0`、`discardReason=null` 且 `failureReason` 有值；任何路径都不再出现 `parameterFeedback` | `parseModelOutput` + `dispatch` 返回值断言 |
| **WIKI-01** | llmwiki 文件与索引写入 | 调度器输出有效 `WikiEntry` + 本轮 `DiscussionSession` | 写入指定 wiki 根目录 | 生成 `wiki/debates/<id>.md` 与 `raw/sessions/<id>.json`，更新 `index.md` 单行索引，追加 `log.md` | 严格遵守 llmwiki 单行索引、真理源只增不改与 `Source:` 可追溯规范 |
| **STORE-01** | 本地数据持久化与查询 | 沉淀完成并持久化 | 调用 `search` 或 `getRecent` API | 能够按关键词搜索到标题/摘要，并按时间倒序查阅 | 本地存储保证离线与群指令高效检索 |

### Web UI / Console 组件补充用例 (WEBUI-02 / 04 / 05 / 06 / 15 / 18)

| 用例 ID | 场景描述 | 预期结果 | 底层判定机制 |
| :--- | :--- | :--- | :--- |
| **WEBUI-02** | 路由清单 | 只注册 `<base>/session`、`POST <base>/login` / `logout` / `bootstrap` 与 `<base>/api/*`；`GET <base>` / `GET <base>/` 必须不存在（服务端不再渲染任何 HTML，UI 只在 Console 浮窗） | 模拟 Router 注册表调用 |
| **WEBUI-04** | Console 组件注入 | `addEntry` 收到绝对路径且目录内存在 `index.js`，仅可能出现 node_modules 403 风险提示 | 模拟 `ctx.console` 捕获入参 |
| **WEBUI-05** | 控制台缺失降级 | 无 console 服务或 `addEntry` 非函数时不注入、不抛错 | 无 console 的 ctx 调用 |
| **WEBUI-06** | 配置表单清洁 | `Config.toJSON()` 序列化结果无 `_preview`、无 `iframe` | Schema 序列化检查 |
| **WEBUI-15** | 客户端产物语法自洽 | `client/dist/index.js` 可被 `new Function` 编译 | 语法编译断言 |
| **WEBUI-18** | 真实时间轴流量绘线 | 空采样不画线、不伪造基线；已监测无消息落在基线 0；X 按真实时间戳定位、Y 按条数/满刻度（峰值不拉满）；缺桶与 NaN 采样断开不跨线；窗口外采样不绘制（过期点不堆积在左边界）；单点画短横线 | 数值坐标断言 |
| **ROUTE-01..10** | 浮窗挂载与本插件页判定 | 任何 `/plugins/**` 页都挂壳（胶囊是入口）；只有本插件页（名字命中或页面身份文本认出）才展开、才弹门禁、才启动数据面；`mount()` 零请求，别的插件页 `fetch` 调用数为 0 且 `state.dataFlow === false`；`own` 变真后首次取数只打 `<base>/api/*`，离开本插件页立刻停链、请求数不再增长 | 产物按函数体载入 + 记账 `fetch` 桩 + 路由桩 |
| **GATE-01..03** | 401 归属（门禁只属于本插件页） | 本插件页的 401 清票据 + 探 `<base>/session` + 挂登录遮罩；`setOwnPage(false)` 后同样的 401 只清票据，不探会话、不挂遮罩；非本页直接调 `gate()` 同样无副作用，`setOwnPage(true)` 后恢复 | 生成块单独载入 + 遮罩挂载计数 |
| **STARTUP-01..02** | 启动期订阅目标候选的目录锚点 | `cwd` 读不到实例时静态 const union 不含实例值（`Config` 拒载）；`installStartupTargets({ baseDir })` 后该目录的已配置值与相册进 union、同一条配置通过校验；同目录只读一次盘、`reload` 才重读；空目录降级为空且不覆盖已装好的 union | 临时实例目录 + `Config` 解析成败 |
| **TRAFFIC-01..03** | 采样与静默群 | 墙钟对齐5秒桶，按接受消息计数；静默为真实0，未监测历史缺失；60点上限、读取副本、启动半桶不丢真实消息 | 虚拟时钟与真实触发器 |
| **LATEST-01..03** | 当前群消息预览 | 仅接受群缓存、无消息null、去除markup、无raw/userId、返回副本、长度上限且不切断代理对；`elements` 恒为非空 JSON 安全 AST 且不含 userId/原始 attrs | 真实系统消息入口与API读取 |
| **LATEST-04** | 最新词条轮播源 | 真实存储按最新排序，限制1–20条，独立于关键词与群筛选 | 真实LocalStore与API查询 |
| **RICH-01..09** | 富消息解析与媒体安全 | OneBot / Koishi 元素归一化为安全 AST；支持图片、引用、合并转发、卡片、视频、语音、文件、@与表情；只读 action 白名单、逐层切片与跨层预算、异步旧消息隔离；仅子资源媒体代理，卡片/文件导航直链保留；媒体正文超时、IPv6 与 Range 安全边界；前端仅构造安全 DOM、不自动播放，同指纹不重建媒体节点 | 真实解析器、API 副本、媒体代理与浏览器 DOM 行为 |
| **MEDIA-01..02** | 同源媒体代理边界 | 收到首包后若响应体停滞仍会超时并中止上游；公网 IPv6 字面地址固定解析并保持 Range/字节流，解析阶段不触发 DNS；IPv4 映射字面量（含点分公网映射 `::ffff:808:808`）在字面量直通分支即判为不可用（403），绝不进 DNS / pinnedLookup / fetch | 可控 readable stream 与固定 IP 抓取器 |
| **QUOTE-UNAVAILABLE** | 引用原消息不可读 | OneBot `get_msg` 返回 1200（撤回 / 过期 / 查无此消息）时不写 warning 日志，预览显示「引用消息不可用」并保留引用者名字与原消息 id；真正的通道故障仍然告警并标记解析失败 | 真实解析器 + 注入 resolver 的成败对照 |
| **FORWARD-UNAVAILABLE** | 合并转发不可读 | OneBot `get_forward_msg` 返回 1200（撤回 / 过期 / 内存表冲掉）时不写 warning 日志，返回 `[合并转发不可用]`；真正的通道故障仍然告警并标记解析失败 | 真实解析器 + 注入 resolver 的成败对照 |
| **WINDOW-RESIZE** | 自定义窗口尺寸 | 八方向边缘/角拖动可缩放；最小尺寸按视口约束、对边锚定、视口内边界；最大化时禁用手柄，还原自定义尺寸并根据容器宽度重排 | 实际浏览器 Pointer Events 操作 |
| **WINDOW-GESTURE** | 手势期间材质恒定 | 拖拽与缩放期间背景与投影保持不变（不切换表面），只关闭过渡；窗口内不存在任何全窗装饰图层（`ptx-film` / `ptx-field` 已彻底移除，缩放不再需要临时隐藏图层）；缩放光标在整个手势内钉住不闪动；`pointerup` / `pointercancel` / `lostpointercapture` 均先撤销排队帧并落定最终几何再结束手势，无旧帧回放；窗口本体不使用背板模糊 | 浏览器计算样式与帧时序对比 |
| **PANEL-SETTINGS** | 设置页与轮播 | 侧栏齿轮就地切换设置页；自动收纳、轮播数量/间隔本地持久化；最新词条轮播与搜索筛选独立；关闭与最小化可分别重开 | 多 surface 浏览器状态与路由交互 |
| **TUNING-01..03** | 自校准边界（已被 AIMD 取代） | 旧「模型给绝对值 + 单向带宽夹紧」实现已删除；边界语义改由下方「AIMD 调节维用例」的 `AIMD-01..07` 覆盖（时间衰减 + 非对称步进 + 硬限幅） | 纯函数边界断言 + SYSTEM-E2E 参数回写断言 |

### 可观测性 AOP 补充用例 (TELEMETRY-01 ~ TELEMETRY-08)

| 用例 ID | 场景描述 | 预期结果 | 底层判定机制 |
| :--- | :--- | :--- | :--- |
| **TELEMETRY-01** | 定容环形缓冲 | 默认容量 300；写满后 FIFO 覆盖最旧条目且容量恒定；`toArray()` 按「最旧 → 最新」返回副本（外部修改不回写内部）；非法容量抛 `RangeError` | 容量 / 顺序 / 副本隔离断言 |
| **TELEMETRY-02** | 差分动量与 RSI | 首个样本只建基线；样本不足 14 步时 `rsi === null`；单调上行 `rsi > 99`、单调下行 `rsi === 0`、完全平直 `rsi === 50`（除零安全）；NaN / 负值 / Infinity 输入被忽略且输出恒有限 | `MomentumTracker` 纯函数断言 |
| **TELEMETRY-03** | 基线账本聚合 | 上行 / 下行 / 平直 / 衰减 / 两类拒绝分别计数与累加；非法输入不落账；1 小时窗口 `(since, now]` 外的旧事件被裁剪；窗口内事件数超过容量时 FIFO 覆盖 | `BaselineLedger` 纯函数断言 |
| **TELEMETRY-04** | 生命周期端到端拦截 | IDLE 期基线账本即有已接受样本 → 密集讨论产生 `PHASE_CHANGE(IDLE→BURSTING)`（含瞬态向量）→ 平息产生 `SESSION_FINALIZED` → 调度回执 `DISPATCH_RESULT` → `AIMD_TUNED`；四者共享同一 `traceId` 且 `eventId` 各不相同；`minDiscussionMessages` 被硬下界夹回写入 `clamped` | 真实系统 + mock 模型 + 事件链断言 |
| **TELEMETRY-05** | 擦肩而过与频控 | 有效速率 ≥ 0.7 × 突发门限且 ≥ 2 名发言人时在 IDLE 记录 `NEAR_MISS`；3 分钟（逻辑时间）内只累加 `nearMissSuppressed` 不重复落 trace；越过频控后再次上报且两次间隔 ≥ 180s | 真实系统 + 合成时间戳 |
| **TELEMETRY-06** | 补丁 100% 还原 | 挂载后 9 个织入点均为自有属性；`dispose()` 后自有属性全部消失、方法恒等于原型方法、`attachedTo === null`；还原后 `onMessage` / `baseline.record` 照常工作且不再产出遥测；重复 `dispose()` 幂等；重新挂载再卸下同样干净 | `hasOwnProperty` + 原型同一性 + 功能回归 |
| **TELEMETRY-07** | 挂载语法糖与可注入阈值 | `attachTelemetry(system)` 与 `new PatchouliInspector().attachTelemetry(system)` 等价且重复挂载幂等；`nearMissRatio=0.5` 时 3 条/分即判定擦肩而过（默认 0.7 需 4.2 条/分），`nearMissCooldownMs` 原样透出到 trace | 自定义 Inspector 行为断言 |
| **TELEMETRY-08** | `GET <base>/api/telemetry` 契约 | 已挂载时回 `attached: true` + 频道快照（闸门 / 动量 / 基线账本 / traces / counters）+ 全局 totals，可 JSON 序列化；宿主替身无 inspector 时回基础空结构（`attached: false`、空 channels/traces），载荷形状恒定 | 注册模拟 Router 后调用处理器 |

### 配置联动与发言人链路补充用例 (CONFIG-01 ~ CONFIG-05 / API-PROMPT-01 ~ API-PROMPT-04 / DISPATCH-03 ~ DISPATCH-08 / PROTOCOL-01 ~ PROTOCOL-11 / API-ENTRY-01)

| 用例 ID | 场景描述 | 预期结果 | 底层判定机制 |
| :--- | :--- | :--- | :--- |
| **CONFIG-01** | dispatcher 条件表单与默认值 | `dispatcher` 是 `intersect([object, union, object])`；provider 下拉**只有** `chatluna` / `custom`（`standalone` / `auto` 留在枚举里但 `meta.hidden`）；`Config({})` → `provider='chatluna'`、`chatlunaModel='无'`、`temperature=0.3`、`maxTokens=6000`、`enableAutoTuning=true`，且解析结果不含 `chatlunaPreset` / `systemPromptPreset` / `customSystemPrompt` | `Config({})` 解析 + 分支 `dict` / `meta.hidden` 断言 |
| **CONFIG-02** | 分支字段集 | ChatLuna 分支只有 `provider` + `chatlunaModel`（`role:dynamic`、`extra.name='model'`、默认 `无`），其 const **不带** `required`（默认值省略兼容）；custom 分支为 `baseURL` / `apiKey`(`secret`) / `customModel` / `protocol` / `responseFormat`，其中 `protocol` 默认 `auto` 且与 `responseFormat` 均 `.hidden()`；公共段 `temperature` / `maxTokens` / `enableAutoTuning` 全 `.hidden()` | 遍历 `intersect` 元素与分支 `dict` |
| **CONFIG-03** | custom 默认值 | 只给 `provider:'custom'` + 三个可见项时补齐 `protocol='auto'`、`responseFormat='json_object'`、`maxTokens=6000`；给定端点字段原样保留 | `Config(...)` 解析断言 |
| **CONFIG-04** | 历史 provider 兼容 | `provider:'standalone'` / `'auto'` 通过校验且解析后保持原值；旧单键 `model` 必须过校验并留在解析结果里（`.hidden()`，不进表单），新键留空由 `resolveDispatcherModels` 回填 | `Config(...)` 解析断言 |
| **CONFIG-05** | Schema 序列化契约 | 序列化 JSON 含 `role:"dynamic"`（模型下拉与相册候选）、`role:"secret"`、`chatluna`/`custom`/`auto`、`responses`/`gemini`/`chat-completions`、`json_object`/`structured`，且**不含** `systemPromptPreset` / `customSystemPrompt` / `role:"textarea"` / `_preview` / `iframe` | `Config.toJSON()` 字符串断言 |
| **CONFIG-06** | 知识周报表单 | `topicDelivery.cron` 是「知识周报」分组的**第一个**字段（string，默认 `30 4 * * 1`）；`albums` 内层为 `any` + `role:dynamic` + `extra.name='patchouli.album'` | `Config.dict.topicDelivery.dict` 键序 / meta 断言 |
| **CONFIG-07** | provider 写回幂等 | `Config({dispatcher:{provider:'custom',…}})` 解析后 `provider==='custom'`；二次 / 三次写回字段完全一致 | 反复 `Config(Config(...))` |
| **CONFIG-08** | 分支可见键不相交 | 两个分支除 `provider` 外的可见键集合互不重叠（`chatluna` → `chatlunaModel`；`custom` → `baseURL` / `apiKey` / `customModel`）：同名可见键在控制台是同一配置路径，切 provider 即串值 | 遍历分支 `dict` + `meta.hidden` |
| **CONFIG-09** | 解析后模型键互不可见 | `Config({dispatcher:{provider:'chatluna',chatlunaModel:X}})` 不含 `customModel`；`provider:'custom'` + `customModel:Y` 不含 `chatlunaModel` | `Config(...)` 解析断言 |
| **API-PROMPT-01** | 提示词查阅接口 | `GET <base>/api/prompt` 回传 `defaultPrompt` / `concisePrompt` 全文、`customPrompt=''`、`isCustom=false`，且 `effectivePrompt === defaultPrompt`；载荷不再含 `preset`；GET 纯读：不写配置、不创建落盘文件 | 注册模拟 Router 后调用处理器 + 文件存在性断言 |
| **API-PROMPT-02** | 提示词热更新与落盘 | `POST <base>/api/prompt` 写入 `customPrompt` 后回传 `isCustom=true` 并自动补齐输出契约，同时原子写入 `<wikiDir>/.patchouli/custom-prompt.txt`（内容与提交逐字一致）；共享同一份配置对象的 `ModelDispatcher` 下一轮请求的系统消息即为新提示词；`customPrompt:''` 一键恢复：清空内存、删除落盘文件、回落内置提示词 | 捕获 `fetch` 请求体 + 真实临时文件断言 |
| **API-PROMPT-03** | 缺省与非法载荷 | 未提供 `customPrompt` 收敛为空串（恢复默认）；非对象请求体返回 400 且不改动现有配置 | 处理器返回码与配置快照断言 |
| **API-PROMPT-04** | 重启回灌与删除 | 预置 `.patchouli/custom-prompt.txt` 后构造 `PatchouliKnowledgeSystem`，`await ready` 即把全文（含换行缩进）回灌到 `config.dispatcher.customSystemPrompt` 并立即生效；`saveCustomPrompt('')` 删除文件并清空内存；文件缺失 / 仅含空白一律收敛为内置提示词 | 真实临时目录 + `ready` 屏障断言 |
| **DISPATCH-03** | Markdown 降级保留发言人 | `## 参与者` → `participants`；`- 质疑者：X` → `opponents`；`buildWikiEntry` 合并会话发言人后不丢人 | `parseMarkdownAnalysis` + `buildWikiEntry` 断言 |
| **DISPATCH-04** | 端点协议与格式映射 | 默认请求 `POST /responses`：system → `instructions`、其余 → `input[]`、`max_output_tokens`、`stream:true`、`store:false`、`prompt_cache_key`；`json_object` → `text.format={type:'json_object'}`；`structured` → `text.format={type:'json_schema',name:'patchouli_wiki_entry',strict:true,schema}`；`text` 不发 `text`；400 提及 `text.format` 时去掉格式重发一次；显式 `protocol:'chat-completions'` 时回到 `/chat/completions` + `messages` + `response_format` | 捕获 `fetch` 请求体与 URL 断言 |
| **DISPATCH-05** | 自评与失败三态 | 同原 DISPATCH-02/05：舍弃归一化、`qualityScore` 恒存在、运行时失败可区分 | 返回值断言 |
| **DISPATCH-07** | provider 二值与历史值兼容 | `normalizeDispatcherProvider`：`custom` / `standalone` → `custom`，`chatluna` / `auto` / 未知 → `chatluna`；`custom` 即使注入 ChatLuna 也不调用 invoker；旧 `auto` 走 ChatLuna 且异常时**不再**回退端点（`endpointCalls=0`、`customModel=''`）；旧 `standalone` 恒走自定义端点 | `normalizeDispatcherProvider` + `route` / invoker / fetch 计数断言 |
| **DISPATCH-20** | 两条通道模型键互不串值（拆键回归） | `resolveDispatcherModels`：`chatluna` 通道只取 `chatlunaModel`、`custom` 通道只取 `customModel`，旧单键只回填当前通道；`provider:'custom'` 且同时给了 `chatlunaModel` 时，端点请求体的 `model` 仍是 `customModel` | `resolveDispatcherModels` 直测 + 捕获请求体 |
| **DISPATCH-08** | 历史配置 + auto 协议探测 | `provider:'standalone'` + Gemini `baseURL`：未发请求前 `protocolId='gemini'`、`chatUrl` 以 `:generateContent` 结尾；`probe()` 命中 `/v1beta/models/gemini-2.5-flash:generateContent` 且 `probe.protocol='gemini'` | 捕获 `fetch` URL + 自检结果断言 |
| **PROTOCOL-01** | 未知协议回退 | `protocol:'future-rpc'` → `protocolId='responses'`，`chatUrl` 以 `/responses` 结尾，构造期告警但不阻断 | `ModelDispatcher.protocolId` |
| **PROTOCOL-02** | Responses 流式 | SSE `response.output_text.delta` 累加；`response.completed` 提供完整 output 与 usage；`cached_tokens` 透传；`[DONE]` 忽略 | 手工 `ReadableStream` 事件序列 |
| **PROTOCOL-03** | 流式缺 output | 只有 delta、completed 不含 output 时用累加正文 + completed usage 还原 | 同上 |
| **PROTOCOL-04** | 流式失败 | `response.failed` / `error` 事件转成不可重试的协议错误 | `ProtocolParseError` |
| **PROTOCOL-06** | Gemini 请求形状 | URL 容忍 bare host / `.../v1beta[/]` / 完整 `.../models/<m>:generateContent`；system → `systemInstruction`，user/assistant → `contents[]`（`user` / `model`，相邻同角色合并）；`json_object` / `structured` → `responseMimeType='application/json'`，`text` 省略；鉴权走 `x-goog-api-key` 头，URL 不含 `key=` | 请求体 / 头 / URL 断言 |
| **PROTOCOL-07** | Gemini 响应解析 | `candidates[0].content.parts[].text` 拼接（跳过 thought 分片）、`usageMetadata.totalTokenCount` → `tokensUsed`、`MAX_TOKENS` → `length`；`promptFeedback.blockReason` / 空 `candidates` 抛 `ProtocolParseError` | `geminiProtocol.parse` 断言 |
| **PROTOCOL-08** | 探测链顺序 | `auto` + Gemini 端点 → `gemini` → `chat-completions`；其余端点 → `responses` → `chat-completions`；显式协议单元素；未知 id 回退 `responses`；`auto` 不在 `MODEL_PROTOCOLS` | `resolveProtocolChain` / `MODEL_PROTOCOLS` 断言 |
| **PROTOCOL-09** | 自动降级与缓存 | `/responses` 404 → 同一次调度改发 `/chat/completions` 并成功；`protocolId` 固定为 `chat-completions`，第二次调度不再请求 `/responses`；日志只含协议切换与状态码，无正文与密钥 | 捕获 `fetch` 序列 + 日志断言 |
| **PROTOCOL-10** | Gemini 端点自动走原生协议 | 未发请求前主候选即 `gemini`；请求 `/v1beta/models/{model}:generateContent` 且带 `x-goog-api-key`；`probe().protocol === 'gemini'` | 捕获 URL / 头 + 自检透出断言 |
| **PROTOCOL-11** | 降级边界 | 400 `Unknown url` → 顺延；Gemini 400 `API key not valid`、429、显式协议 404 均不切换协议（各自只发一次请求）；链尾 404 两条协议各试一次后按普通 HTTP 失败返回 | 捕获 `fetch` 序列 + `protocolId` 断言 |
| **API-ENTRY-01** | 词条详情 API 发言人回传 | `/api/entries/:id` 返回 `participants[]`、`debateMatrix[].proponents/opponents/counterArguments`、共识/未决/引用，且 `markdown` 含 `Participants: [[...]]` | 注册模拟 Router 后调用详情处理器 |

### 词条编辑 / 删除 / 清空补充用例 (API-EDIT-00 ~ API-EDIT-08)

| 用例 ID | 场景描述 | 预期结果 | 底层判定机制 |
| :--- | :--- | :--- | :--- |
| **API-EDIT-00** | 旧宿主路由能力 | 宿主 Router 只有 `get` / `post` 时不抛错，既有详情路由照常注册，`PUT` / `DELETE` 绝不伪造注册 | 精简 Router 替身注册断言 |
| **API-EDIT-01** | 仅改元数据 | `PUT` 校验后调用 `LocalStore.updateEntry`（`tags` 去空白去重），响应与 `GET` 同构：带 `markdown`、`debateMatrix`、`consensus`、`openQuestions`、`keyQuotes` 与解析后的 `participants` | 模拟 Router + 内存仓储替身 |
| **API-EDIT-02** | 正文编辑与索引同步 | 带 `markdown` 时交给 `WikiEngine.updateEntryMarkdown(id, markdown)`（正文以换行收尾）；同时改标题时第三参只带真正改动的字段；只改正文不传索引元数据 | 捕获 `updateEntryMarkdown` 入参断言 |
| **API-EDIT-03** | 请求体与 id 校验 | 非对象 / `status` 越界 / `tags` 含非字符串 / 空标题 / 空补丁 / 空正文一律 400；空 id 400；词条不存在 404；非法请求绝不落库 | 处理器状态码与错误文案断言 |
| **API-EDIT-04** | 旧宿主能力回退 | 无 `updateEntryMarkdown` 时直接覆写推导出的正文路径；无 `updateEntry` 时回退 `saveEntry` 并回填 `record.path`，随后详情即能解析矩阵 | 真实临时文件 + 仓储替身调用断言 |
| **API-EDIT-05** | 删除优先系统层 | 宿主提供 `system.deleteEntry` 时只调用它，不重复调用 `LocalStore.deleteEntry`，响应 `{ ok: true, id }` | 调用序列断言 |
| **API-EDIT-06** | 删除回退链 | 无 `system.deleteEntry` 时先 `WikiEngine.deleteEntry(id, title)` 再 `LocalStore.deleteEntry(id)` | 调用入参断言 |
| **API-EDIT-07** | 删除校验 | 空 id 400、词条不存在 404、宿主无任何删除能力时 500 且 `ok: false` | 状态码与错误文案断言 |
| **API-EDIT-08** | 清空知识库 | 优先 `system.clearKnowledgeBase()`；回退顺序为 `WikiEngine.clearAllEntries()` → `LocalStore.clearEntries()`；均缺失时 500。成功恒回 `{ ok: true, message: '知识库已清空，保留默认骨架' }` | 调用顺序与文案断言 |

### 存储布局补充用例 (LAYOUT-01 ~ LAYOUT-04)

| 用例 ID | 场景描述 | 预期结果 | 底层判定机制 |
| :--- | :--- | :--- | :--- |
| **LAYOUT-01** | 未配置 `wikiDir` | 解析为 `path.resolve(baseDir \|\| cwd, 'data/llmwiki')`；空白串等价于未配置 | `resolveWikiDir(undefined, baseDir)` 断言 |
| **LAYOUT-02** | 相对/绝对路径 | 相对路径（`data/llmwiki` / `./wiki-store` / `../shared/llmwiki`）一律基于 `baseDir` 锚定；绝对路径原样使用、不被二次拼接 | `resolveWikiDir` 枚举断言 |
| **LAYOUT-03** | Config 默认值 | `Config({}).storage.wikiDir === 'data/llmwiki'`，配合 baseDir 解析为 `<baseDir>/data/llmwiki` | `Config({})` 解析断言 |
| **LAYOUT-04** | 骨架创建 | `ensureWikiLayout` 建全 `raw/sessions/`、`wiki/debates/`、`.patchouli/`，幂等且不破坏既有文件；`storePath` 指向 `.patchouli/store.json`，`customPromptPath` 指向 `.patchouli/custom-prompt.txt` | `stat` 目录存在性 + 覆写后内容不变断言 |

### 富消息预览与同源媒体代理补充用例 (RICH-01 ~ RICH-09)

| 用例 ID | 场景描述 | 预期结果 | 底层判定机制 |
| :--- | :--- | :--- | :--- |
| **RICH-01** | 元素归一化全覆盖 | 原始 OneBot 段（text/at/face/img/record/video/file/reply/forward/json/xml/share/music/location/contact/dice/rps/poke/markdown）各自映射到契约内类型；CQ 实体反转义；只有 QQ 号时不得暴露 userId；无输入时 `elements` 仍为非空数组且 `content` 摘要保留 | 真实 `onIncomingMessage` + 元素 AST 断言与 JSON 往返 |
| **RICH-02** | 媒体地址安全 | 仅放行公网 http(s)：`javascript:` / `data:` / `blob:` / `file:` / Windows 与 POSIX 本地路径 / 相对路径 / 私网与 link-local（含云 metadata 地址）/ `localhost` 与单标签内网名 / `.local`·`.lan` 后缀 / 非 80·443 端口 / 带 userinfo 的 URL 全部拒绝；IPv4 映射 IPv6 字面量（`::ffff:7f00:1` / **全展开** `0:0:0:0:0:ffff:a9fe:a9fe` / 大小写混写）按拼回的 32 位判私网·本机·保留段并一律拒绝；`image/svg+xml`、`text/html` 等 active content 不在媒体白名单内 | `sanitizeMediaUrl` / `isAllowedMediaType` / `MediaRegistry.register` / `isIPv4MappedIPv6` 枚举断言 |
| **RICH-03** | 只读 resolver | `get_image` 解析 file → 真实 URL；`get_msg` 补齐引用（标题/正文/targetMessageId）；`get_forward_msg` 展开为 `items[]`；只调用白名单内只读 action（`_get` 优先，参数用标准 `id`）；resolver 抛错时保留元素类型 + 可见 error 文本且记录日志，绝不造假 URL | 假只读通道捕获调用序列 + 元素断言 |
| **RICH-03b** | 只读边界 | 写操作（`send_msg`）绝不被调用；`_request` 回退必须校验 `retcode`，非 0 视为失败而非假成功 | 捕获调用 + retcode 断言 |
| **RICH-04** | 上限明示截断 | 转发节点超限追加「共 N 条转发，仅展开前 M 条」；递归深度超限标注「层级过深，未展开」；顶层元素超限追加「已截断，共 N 段元素」；元素文本按码点截断到上限 | `maxForwardNodes`/`maxForwardDepth`/`maxElements`/`textLimit` 注入断言 |
| **RICH-05** | ark 合并转发展开 | `com.tencent.multimsg` 的 `resid` 走 `get_forward_msg` 展开为 forward 元素并保留 `source`；普通 `structmsg` 卡片不得被误判为合并转发 | 捕获 `get_forward_msg` 入参 + 元素断言 |
| **RICH-06** | 同源媒体代理 | 仅服务已登记 opaqueId（非法 id 400 / 未登记或已失效 404 / 消息覆盖后旧 id 立即失效）；上游连接固定到已校验 IP；Range 透明（206 + `Content-Range`，非法 Range 不透传）；重定向到私网 403、重定向环 502；HTML 415 且不透传；DNS 解析到私网 IP 403；响应恒带 `nosniff`、`inline` 与流式 body；被拒绝的上游立即 abort | 注入 `mediaFetch`/`mediaLookup` 的模拟上游 + 路由处理器断言 |
| **RICH-06b** | 登记表频道隔离 | opaqueId 按 `(频道, URL)` 派生：两群引用同一张图各持独立 id，覆盖一群只失效该群 id，他群仍可继续代理；`register` 拒绝非公网地址；`clearChannel` 后立即失效 | 登记表单元 + 两群端到端路由断言 |
| **RICH-07** | 竞态与浏览器就绪副本 | 晚到的富解析（旧消息）不得覆盖新消息；`/api/status` 元素为浏览器就绪副本（http → 同源代理路径、https → 真实直链） | 慢 resolver 交错 + API 断言 |
| **RICH-08** | 导航字段 vs 子资源字段 | 只有子资源字段（image/video 的 `url`、video/card 的 `imageUrl`、face 的 `emojiUrl`、record 的 `url`）参与代理改写与登记；`card.url`（网页导航）与 `file.url`（下载）保留 `sanitizeMediaUrl` 后的原始安全直链，绝不改写、绝不登记为媒体 | `/api/status` 元素字段断言 + `collectMediaUrls` 集合断言 |
| **RICH-09** | 逐层切片与跨层预算 | 每次遍历前先按元素上限切片（转发条目内 100 段只解析上限内 + 可见截断提示，上限外的段绝不进入结果）；顶层同样先切片；跨层转发节点总数受总预算约束（第二层剩余预算用尽时只展开 1 条 + 提示） | `maxElements` / `maxForwardItems` / `maxForwardNodes` 注入断言 |

### 四维闭环 / AIMD 调节维用例 (AIMD-01 ~ AIMD-07 / SYSTEM-AIMD-01 / TUNE-API-01 ~ TUNE-API-02 / DISCARD-01 ~ DISCARD-04 / PLUGIN-DISCARD-01)

| 用例 ID | 场景描述 | 预期结果 | 底层判定机制 |
| :--- | :--- | :--- | :--- |
| **AIMD-01** | 时间向心力（无新反馈） | 传入 `current` 偏离锚点且 `lastUpdated` 停摆 $h$ 小时，反馈为 `null` | 两个门限按 $0.85^{h}$ 向配置锚点回落，`action='NEUTRAL'`、`decayFactor=0.85^{h}`；即使历史被推到上限，停手后也会自己走回基线 | 纯函数定点断言（无反馈 → 永不单向漂移） |
| **AIMD-02** | `LOW_DENSITY` 收紧门限 | `{ shouldDiscard: true, discardReason: 'LOW_DENSITY' }` | `minBurstRate +0.25`、`minDiscussionMessages +1`，`action='LOW_DENSITY'` | `updateParameters` 步进断言 |
| **AIMD-03** | `FRAGMENTED` 要求完整度 | `{ shouldDiscard: true, discardReason: 'FRAGMENTED' }` | `minDiscussionMessages +2`、`minBurstRate -0.2`（容忍慢节奏但要求会话完整） | 同上 |
| **AIMD-04** | `NOISE_SPAM` 物理零步进 | `{ shouldDiscard: true, discardReason: 'NOISE_SPAM' }` | 两个物理门限零步进（仅时间衰减生效），`action='NOISE_SPAM'`；刷屏交给确定性噪声清洗 | 同上 |
| **AIMD-05** | 高价值讨论放宽 | 未舍弃且 `qualityScore >= 0.8` | `minBurstRate -0.15`、`minDiscussionMessages -0.5`，`action='HIGH_QUALITY'` | 同上 |
| **AIMD-06** | 硬限幅与未知输入 | 连续同向反馈把参数推出边界 / 锚点越界 / 评分越界或非有限 / `current === undefined` | 输出恒在 `minBurstRate ∈ [3,8]`、`minDiscussionMessages ∈ [6,16]`（两个门限均为**连续值**，统一保留 3 位小数；例如 12 经 `HIGH_QUALITY` 得 11.5、经 `FRAGMENTED` 得 14、经 `LOW_DENSITY` 得 13）；越界键进入 `clamped`；非有限评分按「无信号」处理；缺失 `current` 以锚点为起点 | 边界枚举断言 |
| **AIMD-07** | 运行时失败不抬门限 | `{ shouldDiscard: false, qualityScore: 0 }` 或 `null` | `action='NEUTRAL'`，两闸门不增（至多时间衰减）——网络故障绝不能把「本轮没沉淀成功」翻译成「门限太松」 | 纯函数 + SYSTEM-E2E 断言 |
| **AIMD-08** | 势能层目标（`target:'potential'`） | `LOW_DENSITY` / `FRAGMENTED` / `HIGH_QUALITY` / `NOISE_SPAM` 四类信号 | `thetaMin` 步进 `+1.5` / `−1.0` / `−1.0` / `0`，同期 `minBurstRate` **零步进**（只受时间衰减）；输出恒在 `thetaMin ∈ [10,60]`，越界进 `clamped`；`minDiscussionMessages` 步进与 `rate` 层完全一致 | 纯函数定点断言 |
| **TELEMETRY-09** | shadow 势能向量 | `triggerMode='shadow'` 下常态与密集两段 | `GateStatus` 与 `NEAR_MISS` / `PHASE_CHANGE` 的 `data` 同时带 `quality/density/interaction/baselineQuality/coolThreshold`，且与 `gate` 同源；`coolThreshold` 用导出的 `potentialCoolThreshold` 可复算（无第二套公式）；结算后 AIMD 只动 `thetaMin`，`AIMD_TUNED.data.target='potential'`；`rate` 模式不带这些键 | 真实系统 + 遥测快照 |
| **AIMD / TUNE-API / SYSTEM-AIMD 的 rate 回归** | `thetaMin` 引入后 rate 模式逐位不变 | `triggerMode='rate'`（缺省） | `minBurstRate` / `minDiscussionMessages` 步进与夹紧结果与改前一致，`thetaMin` 恒为锚点 20；`/api/status` 的 `tuning` 恒含三键 | `tuning.test.mjs` / `system-e2e.test.mjs` |
| **SYSTEM-AIMD-01** | 主流程闭环接线与持久化 | 真实 `PatchouliKnowledgeSystem` 跑一轮平息结算（成功 / 主动舍弃 / 网络失败三类），另一轮设置 `enableAutoTuning=false` | 三轮都写入 `detector` 新门限并 `saveCadenceState`（`updatedAt === tuning.lastUpdated`，重启回灌为时间基准）；关闭开关时完全不调参；成功 / 舍弃 / 失败分别按 `qualityScore` / `discardReason` / `failureReason` 记录日志，绝不混淆 | 假调度器 + 真实 detector / LocalStore |
| **TUNE-API-01** | `/api/status` 的 `tuning` 契约 | 任意群（含无历史快照的群） | 回传 `tuning.parameters`（AIMD 写入后恒在硬限幅内，从未校准的群等于配置值）、`limits`、`decayFactor`、`highQualityThreshold`、`lastUpdated`（无快照为 `null`）；`options` 仍保留完整 `TriggerOptions`，旧字段不缺失 | 路由处理器断言 |
| **TUNE-API-02** | `/api/tune` 夹紧与时间基准 | 提交越界 `minBurstRate` / 小数 `minDiscussionMessages` / 非闸门键 | 两个闸门均夹进 `[3,8]` / `[6,16]` 并保留 3 位小数（`minDiscussionMessages` 是连续值，`11.5` 原样下发、`5.9999` 夹到 `6`），越界键列入响应 `clamped`；非闸门键原样透传；快照 `updatedAt` 同步为该群 AIMD 时间基准，响应回传新的 `tuning` | 路由处理器 + 系统时钟断言 |
| **TUNE-API-03** | `/api/tune` 的 `thetaMin` 夹紧 | 提交 `99.1234` / `1` / `21.234` / `21.23456` | 夹进 `[10,60]` 并保留 3 位小数（`60` / `10` / `21.234` / `21.235`），越界进 `clamped`；`tuning.limits.thetaMin` 与 `/api/status` 同步回传 | 路由处理器断言 |
| **DISCARD-01** | 缓冲不足不再静默（诊断口） | 平息观察期满时缓冲条数 `< minDiscussionMessages`（如 15 < 25） | `onDiscard` 恰好调用 1 次且 `channelId` / `messageCount`（等于实际缓冲条数）/ `minDiscussionMessages` / `peakRate`（等于本轮峰值）/ `triggerReason`（含「触发门限」口径）全部正确；沉淀回调零调用；相位回到 `IDLE` | 真实 detector + 隐式时钟推进 |
| **DISCARD-02** | 完备会话标记 | 缓冲条数 `≥ minDiscussionMessages` 的正常平息结算 | 交付的 `DiscussionSession.partial === false` | `finalize` 交付对象断言 |
| **DISCARD-03** | 软切片标记 | 缓冲达 `BUFFER_SOFT_SLICE_MESSAGES`（120 条）触发强制交付 | 交付的 `DiscussionSession.partial === true`、`messages.length ≥ 120`、`triggerReason` 含「软切片」，相位仍非 `IDLE` | `flushSlice` 交付对象断言 |
| **DISCARD-04** | 诊断回调异常隔离 | `onDiscard` 同步抛错 | 异常不外溢（`onMessage` 不抛），仅转交 `onError`；相位仍回 `IDLE`，随后新一轮突发可正常进入 `BURSTING` | try/catch + 状态机续跑断言 |
| **PLUGIN-DISCARD-01** | 软切片不参与 AIMD（反馈隔离） | 真实 `PatchouliKnowledgeSystem`：① 121 条密集消息触发软切片；② 14 条讨论 + 越过平息期触发完整结算；③ 缓冲不足 8 < 12 的丢弃轮 | ① `minBurstRate` / `minDiscussionMessages` 保持 `6` / `12`，`loadCadenceState` 仍为 `undefined`，无「AIMD 调节」日志但有「软切片交付不参与 AIMD 门限调节」info 日志；② 高质量完整会话照常放宽为 `5.85` / `11.5` 并落盘快照；③ 仅产生「讨论不足未沉淀：缓冲 N 条 < 下限 12 条（峰值 R/m）」日志，不写快照 | 假模型通道 + 真实 detector / LocalStore / logger 断言 |


### 基线静默衰减与门限天花板补充用例 (DECAY-A ~ DECAY-B)

| 用例 ID | 场景描述 | 预期结果 | 底层判定机制 |
| :--- | :--- | :--- | :--- |
| **DECAY-A** | 高位基线 + 长静默 + 慢热讨论 | 基线 4.0、静默 3 小时后首条消息使基线回落至 `MIN_BASELINE_FLOOR`（~1.0）；随后 20s → 10s → 7s 的递增消息流在 01:28~01:30（偏移 60~180 s）进入 `BURSTING`，触发速率 `> 6` 且 `<= minBurstRate × 1.8`，爬坡期基线始终 `< 1.5`（上行不污染） | 真实 `BurstQuiescenceDetector` + 注入时钟 / 惰性调度器 / 预言基线 |
| **DECAY-B** | 速率长期低于基线 | 基线 4.5、每 20 秒一条（3 条/分）持续 5 分钟：基线逐步单调不增，5 分钟后至少回落 0.5 条/分并 `< 4.0`；相位恒 `IDLE`，无沉淀回调 | 同上（下行无条件学习不得被闸门拦住） |

---

### 丢弃轮次留证补充用例 (DISCARD-DUMP-01 ~ DISCARD-DUMP-06)

| 用例 ID | 场景描述 | 预期结果 | 底层判定机制 |
| :--- | :--- | :--- | :--- |
| **DISCARD-DUMP-01** | 落一份留证文档 | `.patchouli/discards/<YYYY-MM-DD>-<sessionId>.json` 生成；文档 = `RawSessionDocument` + `verdict{kind,discardReason,qualityScore,recordedAt}`；消息逐字段可读回，且不含 `raw` 事件对象 | `saveDiscardDump` + `toRawSessionDocument` |
| **DISCARD-DUMP-02** | 超出保留上限 | 连写 4 份 + `limit: 2`：目录只剩最新两份（按写入时间升序比对）；`DISCARD_DUMP_LIMIT = 40` 为默认值 | `pruneDiscardDumps` 按 mtime 升序删除 |
| **DISCARD-DUMP-03** | 目录不存在 | `listDiscardDumps` 返回 `[]`，`pruneDiscardDumps` 不抛 `ENOENT`；`WikiLayout.discardsDir` 恒为 `.patchouli/discards` | `isMissingDirError` 容忍 ENOENT / ENOTDIR |
| **DISCARD-DUMP-04** | 模型判定舍弃 | 真实 `PatchouliKnowledgeSystem` + 假模型返回 `shouldDiscard`：留证 `kind=MODEL`、`discardReason=LOW_DENSITY`、`qualityScore=0.15`，`messageCount` 等于本轮缓冲全部消息，`wiki/debates/` 仍为空 | 插件 `handleQuiescence` 舍弃分支 |
| **DISCARD-DUMP-05** | 缓冲不足（未调模型） | `minDiscussionMessages=50`、本轮 10 条：模型一次都不调用，留证 `kind=FLOOR` 且带 `minDiscussionMessages=50` | `DetectorDiscardInfo.messages` + `onDiscard` 组装 |
| **DISCARD-DUMP-06** | 调度运行时失败 | 模型端点 503：留证 `kind=FAILURE`、`failureReason` 非空、`discardReason` 为 `undefined`（不得把失败伪造成「判定为噪声」） | 插件失败分支与舍弃分支严格分离 |
| **DISCARD-DUMP-07** | 字节预算（8 MiB 默认） | 三份各 2KB+ 的留证：预算只够最新两份时最旧一份被删；预算连一份都不够时**仍保留最新一份**，绝不删空 | `pruneDiscardDumps` 从最新往旧累计 size |
| **DISCARD-DUMP-08** | 单条内容截断 | 3000 个代理对字符截到 `DISCARD_MESSAGE_MAX_CHARS`（2000 码点）且以 `…` 收尾、不出现半个代理对；短消息原样保留 | `clampMessageContents` 按码点切片 |
| **DISCARD-DUMP-09** | 开关关闭（默认值） | `observability.discardDumps=false` 时舍弃轮次**零写入**，`.patchouli/discards/` 目录也不创建（`fs.stat` 必须 ENOENT） | 插件 `recordDiscard` 首行短路 + 懒创建目录 |

---

### 跨时间主题聚合用例 (TOPIC-01 ~ TOPIC-07 / TOPIC-SCHED-01 ~ TOPIC-SCHED-05)

| 用例 ID | 场景描述 | 预期结果 | 底层判定机制 |
| :--- | :--- | :--- | :--- |
| **TOPIC-01** | 普通条目聚类为主题 | 同组词条生成 `Kind: topic`，含主题综述/时间轴；来源词条仍为普通词条、不 superseded | `TopicCurator` + 完全链接聚类 |
| **TOPIC-02** | 新条目追加旧主题 | 沿用旧主题 id、时间轴增长、旧贡献保留；重跑无剩余 → `no-entries` 零写入 | 时间轴 entryId 去重 + 未分配过滤 |
| **TOPIC-03** | 候选不足 | 孤立词条且无可挂靠主题 → `no-entries`，模型零调用 | 分组门槛 |
| **TOPIC-04** | 模型输出非法 | `model-failed` 且零文件 | JSON 解析短路 |
| **TOPIC-05** | 越界 id | 越界 `timeline.entryId` / `topicId` 只丢该组，其余照写 | 子集校验 |
| **TOPIC-06** | 来源仍可见 | 归入主题后来源词条仍在词条页与索引，不标 superseded | 保存路径零改写 |
| **TOPIC-07** | Markdown 契约 | `## 主题综述` 在 `## 时间轴` 前，时间轴格式 `- YYYY-MM-DD 《标题》 — 贡献`；矩阵/共识/名词注/摘句保留 | `renderEntryMarkdown` |
| **TOPIC-SCHED-01..05** | 调度水位 | 成功后当天封盘、重启不重跑；04:00 前不触发、过点补跑；失败 30 分钟退避；手动 `runNow(force)` 透传；水位损坏容错 | `TopicScheduler` |

### 群内问询与投递用例 (ASK-01 ~ 12 / CARD-01 ~ 07 / DELIVERY-01 ~ 07)

| 用例 ID | 场景描述 | 预期结果 | 底层判定机制 |
| :--- | :--- | :--- | :--- |
| **API-TOPICS-01** | 手动主题校准入口 | 缺省按**订阅目标群**扇出（订阅表生效时只跑来源群，表为空才回退旧白名单；`features.topics` 总闸关掉时目标为空）、`force` 透传、逐群返回 `createdTopicIds/updatedTopicIds/assignedEntryIds`；指定 `channelId` 只跑该群且不再解析目标表 | `registerWebUi` 路由 + `topicTargets` / `runTopics` 调用记录；真 system 侧见 `SUBS-HTTP-10` |
| **AUTH-01..17** | 管理面鉴权（会话 + 首次初始化） | 未配置 fail closed；登录换 64 位会话、Cookie/Bearer 双通道；错误令牌 / 未知会话 / 无凭据分别归类；长期令牌可运维直连；过期即拒且过半滑动续期；登出吊销幂等；守卫 401 短路；Cookie 不含长期令牌；`/session` 自检与 `bootstrapRequired`；会话表上限；`/bootstrap` 生成 32B 密钥并落盘 0600、自定义密钥 ≥16、已配置 409、重启用落盘密钥恢复；私网/回环判定；公网或 `x-forwarded-for` 透传公网时 423 且不落定 | `TokenAuthority` / `handleBootstrap` |
| **DELIVERY-BATCH-01..04** | 批量投递 | 有 `broadcast` 时单次提交并透传 retry；只有 `deliver` 时退化为逐个；无服务时相册目标结构化失败；空目标表直接成功 | `deliverCardToTargets` |
| **ENTRY-DELIVER-01..05** | 词条投递目标 | 未改道时按相册表逐个投递；配置 `redirectChannelId` 后只发该群聊天（相册被忽略）；改道目标允许带平台前缀；非法 / 重复相册串丢弃；两者皆空返回空表供调用方告警 | `planEntryTargets` |
| **MEDIA-01..08** | 卡片素材池 | 目录为空即禁用（零 I/O）；低于水位补到 `batch` 条、达水位不重复请求；在线消费即删并返回 `data:` URI；文件名 FIFO；一言去重并截断 120 字；离线模式不触网、消费转入 `used/`、冷却后回到队列（环形）；非图片响应不落盘；配置 `apiKey` 时附加 `key` 参数且保留既有查询串、未配置则匿名 | `MediaPool` + 桩 fetch |
| **CARDSEQ-01..06** | 卡片序号（按群独立） | 每群各自从 1 递增；同一词条恒同号且与传入群无关；跨实例延续（文件 `{version:2,channels:{群:{next,map}}}`）；同 id 并发同号、异 id 不重号；结构不符 / 损坏一律当空表从头数；空路径只内存计数 | `CardSequence` |
| **API-CARD-01..03** | 管理面长图导出 | `GET /patchouli/api/card/:id`：空 id 400、缺失 404、无 puppeteer 503 + 纯文本（不伪造图片）、有 puppeteer 时 `image/png` 且渲染 HTML 已脱敏（不含真实昵称与号码）、页眉带序号、页脚为一言、整张卡不含任何 URL | `registerWebUi` 模拟 Router + 假 page |
| **DELIVERY-01..07** | 投递桥 | 只认 `ctx['miyako-delivery']`；**服务缺失时频道目标也显式失败且不触碰 bot**；服务异常收敛为 `DELIVERY_FAILED`；卡片以图片元素投递 | `getDeliveryService` / `deliverElements` |
| **ALBUM-01..17** | 群相册候选目录 | 投递服务优先、空结果回退 bot；`data.attach_info`/`has_more` 翻页；单群空结果保留旧候选；退群丢弃；**表外群的历史缓存被 `scopeAlbumCandidates` 丢弃，`configured` 点名的具体相册（含旧命名）仍保留、同群其它相册不出现**；union 以空值为首并保留已配置未探测项；频道条目归一；缓存往返与损坏容错；`get_group_list` 覆盖全部群；目标候选 = `@chat` + **按群分段**（每组一条 `#group:<群号>` 的 `Schema.disabled()` 标题项、文案就是群名，组内按相册名排序，标题项不可选且被 `resolveTarget` / 归一丢弃；**相册项取值 = 唯一可读名**（相册名；同批重名一律改成 `群名 · 相册名`、群名也重再追加 `（群号）`、仍重加 `#n`，名字缺失回退稳定地址，`@chat` / `#group:` 为保留值），文案与取值一致；旧名 / 旧地址作为不可选保留项并注明能否解析；无空串项、`@chat` 不重复）；目标注册 schema 是 `array(const union)` + role `select`（标签多选）；**启动期静态候选** `readStartupTargetValues`：读实例配置 + `<wikiDir>/.patchouli/albums.json`、键名变体（`~` / `:id` / 分组嵌套）与自定义/缺省 `wikiDir`、配置缺失或损坏时静默降级为空；**启动期辅助表** `readStartupTargetTables`：`nameToValue`（**只来自 `settings.json` 的 `targetBindings`**，候选不参与解析，ALBUM-16 断言；启动期读盘路径一律锚定 `ctx.baseDir`——进程 cwd 指向别处时仍读实例目录，`baseDir` 为空才回退 cwd，ALBUM-15b 断言）与 `valueToName`（日志展示 `相册名（群号）`，来自当前候选）；`albumUnionItems` 原地替换 `inner.list` 后序列化与校验随新候选（ALBUM-12，重载刷新可行） | `probeGroupAlbums` / `mergeAlbumCandidates` / `scopeAlbumCandidates` / `albumSchemaUnion` / `albumUnionItems` / `albumTargetOptions` / `legacyAlbumTargetOptions` / `subscriptionTargetsSchema` / `readAlbumCache` / `readStartupTargetValues` / `readStartupTargetTables` |
| **BIND-01..05** | 名字→地址绑定表（`targetBindings`） | 保存时用当时候选绑定，落盘与订阅表同一次原子写；**同群同名相册交换探测顺序 → 已保存目标的最终地址不变**；**唯一名消失 + 新群出现同名相册 → 已绑定继续投老地址、掉绑后停投并 warn，绝不改投**；候选为空（探测掉线）不清空绑定；首轮迁移一次性填充且幂等（绑定表非空不重写），迁移完成标记 `bindingMigration` 与绑定表同一次落盘 → **用户删光绑定后重启不按当前候选重新解析同名相册**；面板保存把解析不到的名字留在行里并返回 `unresolved` | `resolveTargetBindings` / `readTargetBindings` / `readTargetBindingMigration` / `writeTargetBindings` / `PatchouliKnowledgeSystem.updateSubscriptions` / `POST /api/subscriptions` |
| **SUBS-01..22** | 订阅表编译（多值目标） | 空表回退旧配置；`*` 行监听全部群；`@chat` 解析为来源群聊天（无来源 / `*` 来源丢弃）；多值目标合并去重、非法项丢弃；`*` 行里的 `@chat` 丢弃（无具体来源）；历史单值 `target` 归一成 `targets`（`目标 = 来源群` 等价写成 `@chat`）；**归一原样保留名字**、投递期按唯一名表解析（未登记 / 歧义名字丢弃并 warn、`@chat` 恒为保留值、`#group:` 丢弃）、名字与旧地址指向同一投递点只投一次、面板接受候选唯一名 ∪ 稳定地址 ∪ 现有值（`@chat` 恒可写）；POST 校验的值域 / 去重 / 单行 ≤16 / 总行 ≤256 / 目录为空时只做形状校验 / 拒绝 `#group:` 分组标题；日志目标显示 `相册名（群号）`（值先解析成地址再取文案，解析不了原样回显）、`@chat` → 本群聊天、分组标题不显示；**空表回退的旧白名单保持精确匹配**（`onebot:123` 与 `123` 不互相命中，与升级前 `channels.includes` 同义），表生效时才按裸群号归一；**`*` 行 + `@chat` 在 POST 校验即 400**（存下去也投不了） | `compileSubscriptions` / `isListening` / `resolveTarget` / `resolveTargets` / `albumValueOfTarget` / `buildTargetNameIndex` / `installSubscriptionTargetLabels` / `installSubscriptionTargetWarnings` / `normalizeSubscriptionRows` / `validateSubscriptionRows` |
| **SUBS-HTTP-01..10** | 面板订阅接口 | `GET /api/albums` 缓存优先（命中不探测）、冷启动探测一次并回写、探测失败降级空目录不 500；`GET /api/subscriptions` 带 `source`（`settings`/`config`）与相册目录；`POST` 校验失败 400、成功落 `settings.json` 顶层 `subscriptions` 且与标量段互不抹除、绝不写宿主 config、并发串行、覆盖层整段顶替 config 并即时改变监听范围；**`topicTargets` 目标群判定**：订阅表生效只跑订阅来源群（`config.channels` 旧群不参与）、表为空回退旧白名单、`features.topics` 关掉为空 | `registerWebUi` + 真 `PatchouliKnowledgeSystem` + 模拟 Router |
| **WEEKLY-01..05** | 知识周报排程 | 空表达式回落默认并按 `Asia/Shanghai` 注册；配置表达式收敛空白后使用；段数不足 / 宿主解析抛错 / 缺 `scheduleCron` 一律不注册且留可读告警 | `registerWeeklyCron` |
| **WEEKLY-SCOPE-01..09** | 知识周报按来源取材与投递 | 只给 A 开周报时只渲染 / 投递 A 的主题（B 的标题不进卡）；`*` 行取全库；订阅表为空保持旧的「全库 + `albumDelivery.albums`」；同来源多行目标一张图多目标且 `dedupeKey=<分钟桶>:<来源>:<相册>`；来源无主题记 info 不渲染；无相册目标 `album-not-configured`；过期主题不参与且全过期 `no-topics`；取材上限 500 | `runWeeklyAlbumDelivery` / `planWeeklyAlbumSources`（注入假 store / render / deliver） |

---

### 势能公式 / 边界标注 / 判决客户端 / 脱敏与长图 / 扁平 Schema / 势能触发行为用例 (POTENTIAL-01..16 / BOUNDARY-01..06 / JUDGE-01..07 / MASK-01..06 / LONGIMAGE-01..06 / MEDIA-01..08 / CARDSEQ-01..06 / CONFIG-07 / ENTROPY-01..06 / SCRIBE-01..05 / SCRIBE-STORE-01..10 / GATE-01..05)

| 用例 ID | 场景描述 | 预期结果 | 底层判定机制 |
| :--- | :--- | :--- | :--- |
| **POTENTIAL-01** | 单条信息量三因子正交 | 与上一条完全相同的文本 `I=0`；20×「啊」`I<0.2`（`h=1/19`）；10 字正常短句落在固定区间；150 字全新论述 `I>3.8` 且单条 `N_equiv=3.0` | `messageInformation` + `effectiveMessageCount` 定点断言 |
| **POTENTIAL-02** | 漏桶闭式衰减 | 无清理期间相邻两次 push 与 `E_k·2^(-Δt/τ)` 精度 1e-9 一致；跨 τ 衰减到约 0.5 倍 | `PotentialTracker.push` 轨迹断言 |
| **POTENTIAL-03** | 消息计数与信息密度 | `N(t)` 同核衰减；恒定 I、固定间隔长跑后 `ρ` 收敛到 `Ī` | 同核衰减 + 稳态收敛 |
| **POTENTIAL-04** | 交互熵 `S_turn` | 三人信息均分 = 1.0；单人独白 = 0；一长文 + 一 4 字短句 ≈ 0.38（±0.03） | `interaction` 断言 |
| **POTENTIAL-05** | `E := ΣE_u` 不变量 | 连喂 30 条后 `\|ΣE_u − energy\| < 1e-9`；故意触发一次清理后仍成立；清理后发言人 Map 不再无界增长 | 裁决口径（E 由求和给出） |
| **POTENTIAL-06** | URL / 代码块归一化 | 同 host 多 URL 只计一个记号，ν 不虚高；80 行代码块 `L=80`、`I/同长度自然语言 < 0.82` | `normalizePotentialText` + `I` 断言 |
| **POTENTIAL-07** | 等效消息数 | `clamp(I/1.5, 0.5, 3.0)` 上下界生效；`I=0` 记 0；`[4.5×4] → 12` | `effectiveMessageCount` |
| **POTENTIAL-08** | 冷却闭式解 | `E=40, Θ=10, τ=240` → `at+480000`（±1ms）；`E ≤ Θ` → `null` | `potentialCrossingAt` |
| **POTENTIAL-09** | `recentTexts` 人类可读 | 返回文本不含私用区码点，URL 显示为 `[链接:<host>]`、代码块显示为 `[代码 N 行]`；条数受 `limit` 与 `recentK` 双重约束 | L2 tail 契约 |
| **POTENTIAL-13** | 密度基线 `b_ρ` 与 `ρ_eff` 裁决 | shadow 模式下 20 条高密度长文预热后 `b_ρ > rhoMin`、`ρ_eff = b_ρ`；再补 2 条四字短句使 `ρ ∈ (rhoMin, ρ_eff)` 且 `Q > Θ_burst`：`verdicts.potential.ready === false`（按裸 `rhoMin` 会误判就绪）；同一条流把 `densityMultiplier` 设为 0 时 `ρ_eff === rhoMin` 且就绪（对照），设为 2 时 `ρ_eff = 2 × b_ρ`；裁决与 `metrics.potential` 共用同一 `ρ_eff` | `effectiveRhoMin` + `evaluateVerdicts` 同口径断言 |
| **POTENTIAL-14** | 峰值比例冷却 `Θ_cool` | `peakQuality` 缺省 / 0 时逐位退化为基线口径（`b_Q=40 → 44`）；峰值 120 × 0.5 = 60 高于基线；任意峰值封顶到 `Θ_burst × 0.99`；`peakCoolFraction=0` 关闭叠加、0.25 时低于基线取基线；五档 `b_Q` × 五档峰值扫掠下 `Θ_cool` 严格小于 `Θ_burst` 且不低于「基线口径与封顶的较小者」 | `potentialCoolThreshold` 纯函数 + 迟滞带不变量 |
| **POTENTIAL-15** | 话题边界势能衰减 `applyBoundary` | `factor=0.5` 后 `E` / `N` 同时折半、`ρ` 不变（1e-9）、`Q` 随 `E` 同比折减；`recent` / `gramCounts` 清空 ⇒ 跨话题重述同一段长文仍得 `I > 0`；`factor` 为负 / 大于 1 / `NaN` 抛 `RangeError`；接线：`noteBoundary → sliceAt` 交付前段后残余势能折半（同一逻辑时刻比较） | `PotentialTracker.applyBoundary` + 探测器中真实边界交付 |
| **POTENTIAL-16** | 会话峰值 `potentialPeak` | 势能模式完整结算（`partial:false`）的会话携带 `potentialPeak`，`quality > 0`、`density > 0` 且 `quality ≥ burstThreshold`；结算后 `sessionPeakQuality` 清零；`Θ_cool` 接线等于 `min(max(基线, peak × 0.5), Θ_burst × 0.99)` 且不越 `Θ_burst`；rate 模式会话的 `potentialPeak` 为 `undefined` | `finalize` / `sliceAt` 会话组装 + 峰值门限同口径 |
| **BOUNDARY-01** | 同话题不切 | 15 条共享词干消息 → 零候选 | Dice 落差判据 |
| **BOUNDARY-02** | 明显话题切换 | 前 10 条讲采光、后 10 条讲网络插件 → 恰好 1 个候选，`at` 为第 11 条时间戳 | 局部极小 + 落差阈值 |
| **BOUNDARY-03** | 首尾与下界 | 候选不出现在首尾；`minMessages` 未满足时零候选 | 索引约束 |
| **BOUNDARY-04** | 确定性可重放 | 同输入连跑两次候选数组 `deepEqual` | 纯函数 |
| **BOUNDARY-05** | 流式 == 批量 | 逐条 `push` 收集结果与 `detectBoundaries` 完全一致 | 终局化游标语义 |
| **BOUNDARY-06** | 复杂度有界 | 2000 条交替话题 push 总耗时 < 500ms（实测约 54ms），`size === 2000`，且流式与批量一致 | 增量 2-gram + 有界窗口 |
| **JUDGE-01** | TypeSafe `noul` 门控 | `answers.valuable.noul` → `gate().probability`；URL 以 `/v1/systemone` 结尾、`Authorization: Bearer`、`questions.valuable.type='noul'` | 注入假 fetch |
| **JUDGE-02** | `choice` 边界裁决 | 选中最可能项；`choice='none'` → `index=null` 且 `available=true` | 同上 |
| **JUDGE-03** | 非 2xx | 500 / 401 → `available=false`、`reason` 含状态码、不抛 | fail-open |
| **JUDGE-04** | 超时 | `timeoutMs: 20` 且 fetch 只在 abort 时 reject → `available=false`，定时器已清理（进程不挂起） | `AbortController` + `clearTimeout` |
| **JUDGE-05** | 响应不可解析 | 畸形 JSON / `answers` 缺失 / 概率越界 → `available=false` | 防御式解析 |
| **JUDGE-06** | opt-in 默认关 | `enabled:false` → 假 fetch 调用次数 0 | §7.5.10 opt-in |
| **JUDGE-07** | 候选准则生成 | `boundary('…', [3,7])` 默认 criteria 含 `3` / `7` / `none` 三键 | 契约字段 |
| **MASK-01** | 昵称稳定映射 | 同 masker 内同一真实名多次映射恒定；空串原样返回 | `createMasker` FNV-1a + 线性探测 |
| **MASK-02** | 洗牌 | 不同 seed 产生不同别名，全部取自幻想乡角色池且互不重复 | 同上 |
| **MASK-03** | 视图脱敏一致性 | `participants` / `quotes.speaker` / `proponents` / `opponents` 全部脱敏且同一人前后一致 | `maskPublicView` |
| **MASK-04** | 提及与号码 | `@昵称` 与 5~12 位号码（含群号）被替换；伪号 ≠ 任何真实号；同号同伪号 | 先登记后替换 |
| **MASK-05** | 不改入参 | 深比较原对象不变；短名 / 空串 / 无提及不崩 | 纯函数投影 |
| **LONGIMAGE-01** | 长图结构 | 页眉左侧 `#自然数序号 // PATCHOULI KNOWLEDGE` 书脊式眉题（缺省退回词条 id）；无一言时不渲染页脚、有一言时以一言收尾且不再有品牌/id；含标题与词条 id；`<script` 计数 0；外链计数 0（仅允许内联 SVG 命名空间）；五要素（立场标题/▲▼立场图标胶囊/论据/反驳，支持质疑已图标化）以「争点块」呈现；人名由 `.nm` chip 包裹且带 `--nm-bg` 色相变量；宽度 720 | 自包含 + 设计契约 |
| **LONGIMAGE-02** | 默认脱敏 | 含真实昵称与 QQ 号的视图出图后，HTML 中不出现原昵称与原号码，同一人别名一致 | `masked` 默认 true |
| **LONGIMAGE-03** | 无 puppeteer 降级 | `ctx={}` 时 `renderEntryLongImagePng` 返回 `null` 且不抛 | 降级不造假图 |
| **LONGIMAGE-04** | 脱敏开关 | `masked:false` 时原昵称可见（证明开关生效） | §8.2 |
| **LONGIMAGE-05** | 截图路径 | `fullPage` 优先；超 `maxHeight` 走视口 + `clip`；宿主不支持 `fullPage` 时回退；任何路径 `page.close()` 恰好一次 | 截图调用序列断言 |
| **CONFIG-07** | provider 写回幂等 | `Config({dispatcher:{provider:'custom',apiKey:'sk-test',baseURL:'https://x.example/v1',customModel:'m'}})` 解析后 `provider==='custom'`；二次/三次写回字段完全一致；历史 `standalone` / `auto` 由 CONFIG-04 覆盖 | 条件 Schema 反复写回回归 |
| **SCRIBE-01** | 主动书记员启停 | `startManualSession` 即入 `BURSTING`；随后 4 条消息间隔 10 分钟**不**自动平息、不交付、不丢弃；`stopManualSession` 立即交付全部 4 条（`partial:false`）并进入 `SUMMARIZING`，`completeSummarizing` 回 `IDLE` | 真实探测器 + 注入时钟/调度器 |
| **SCRIBE-02** | 录制期软切片与 2h 熔断 | 125 条时第 120 条触发一次软切片（`partial:true`、120 条、相位仍 `BURSTING`、`manualRecording` 保持）；随后静默 2h1m 由录制期专用定时器熔断，交付剩余 5 条并复位 | `MAX_MANUAL_IDLE_MS` 熔断路径 |
| **SCRIBE-03** | 进程重启恢复 | 落盘 10 条 → 销毁实例 → `restoreScribeSessions` 恢复 `manualRecording` 与 10 条缓冲 → 续写 5 条 → `rec off` 一次交付 15 条 | `ScribeStore` + `detector.restoreManualSession` 端到端 |
| **ENTROPY-01** | 单条信息量三因子正交 | 完全同文 `I=0`；`'啊'×20` `I≈0.0182 < 0.2`；10 字短句 `I∈[2.0,2.15]`；158 字新论述 `I≈4.80 > 3.8` 且 `N_equiv=3.0` | `messageInformation` / `effectiveMessageCount` 定点断言 |
| **ENTROPY-02** | 小群慢速深聊 + 回溯建仓 + 等效消息数 | `tests/fixtures/slow-debate.json`（3 人 × 5 条 76–80 字、90s 间隔）；注入 `thetaMin=8 / rhoMin=2.2`：前 2 条 `IDLE`，第 3 条 `Q=9.58` 进 `BURSTING`，缓冲含全部 5 条（回溯 60s 窗外的第 1 条长文），`N_equiv≥12`，平息后交付 5 条 `partial:false` 且零 `onDiscard` | 真实探测器 + 固定 fixture |
| **ENTROPY-03** | 单人独白与伪双人 | ① 单人 10 条长文：`S_turn=0 ⇒ Q=0`，恒 `IDLE`；② A 5 条长文 + B「确实如此」：`S_turn<0.9`、`Q<20` 不误触（roadmap 的 0.40 需 A 能量达 B 的 12 倍，受 `C=ln(1+|G|)` 对数上限约束不可达，故断言「严格小于 1」） | `PotentialTracker` 快照 |
| **ENTROPY-04** | 花式接梗 | 12 条 15 字烂梗（前 32 字互不相同，1 分钟）：旧判据 `entropyRatio=1.0`、`effectiveRate=12` 会触发；新判据全程 `IDLE`（`Q≈5.9<20`、`ρ≈0.53<1.2`） | 旧判据对照 + 真实探测器 |
| **ENTROPY-05** | 稳态闲聊不触发 | 6 条/分、5~8 字互不重复、30 分钟：相位恒 `IDLE`、零交付零丢弃；`b_Q` 学到日常量级（≈44，非 0）并在后 10 分钟收敛（变化 <5）、始终 `< thetaMin` | 预热闸门 + Q 基线上行参照 |
| **ENTROPY-06** | 活跃群可冷却 | 同一底噪后叠加 3 分钟密集争论（20 条 6 段轮换长文 / 9s）：进入 `BURSTING`；争论停止、底噪继续时在 `quiescenceSeconds×2.2 + 240s` 内完成一次 `partial:false` 结算（实测约 6.3 分钟），不得只靠 120 条软切片 | 闭式冷却 + 定时器推进 |
| **MASK-06** | 伪号不撞后续真实号 | 先扫全视图号码再投影：引文里的 A 映射成 P、标题里写着真实 P 时，输出既不含 A 也不含 P，且重复调用稳定 | `reserveRealNumbers` + 整词替换 |
| **MASK-07** | 名单外裸名 | 只被正文裸提、没进金句/观点矩阵的名字，`maskPublicView` 第三参 `extraNames` 必须覆盖；复合昵称与底名共享假名 | `extraNames` + `canonicalNameKey` |
| **MASK-08** | 短名边界 | 独立 `7` 换成假名；`1527` 里的 `7` 不动；中文名紧贴汉字（`与千聆进一步`）仍整串命中 | ASCII 名走词边界，中文名走整串替换 |
| **MASK-09** | 会话补名 | `raw/sessions/<id>.json` 的 `userName` 并入名单，补齐 `participants` 漏掉的人；脏 dump 返回空数组不抛 | `collectSessionNames` |
| **MASK-10** | 单字非 ASCII 名守卫 | `夜` 这类单字中文名不登记，正文所有该汉字不被替换 | P1 回归：单字是高频频字 |
| **SHADOW-LEDGER-01** | 台账追加语义 | 决策 / 会话各一行可解析 JSON；从未写入时不建空目录 | 三天对照的数据源 |
| **SHADOW-LEDGER-02** | 按逻辑时间分片 | 跨天记录落在 `shadow-YYYY-MM-DD.jsonl` 两个文件 | 重启/回放可分片归档 |
| **SHADOW-LEDGER-03** | 串行写 | 并发 40 次 append 后行数为 40 且无覆盖 | 裁决/结算并发安全 |
| **SHADOW-LEDGER-04** | 超限续写 | 单文件超 8MB 后写 `-2` 分片，旧文件不截断、条数不丢 | 长跑有界 |
| **SHADOW-LEDGER-05** | 保留期清扫 | `sweep` 只删超过 14 天的分片 | 磁盘有界 |
| **SHADOW-LEDGER-06** | 目录外部删除 | 重建后重试一次仍能落盘，不抛 | 可观测性不阻塞主流程 |
| **SHADOW-LEDGER-07** | 双判据同口径 | `evaluateVerdicts` 的门限与状态机同一函数（ρ_min / Θ_burst），未知群返回 null | 禁止两套公式 |
| **TELEMETRY-12** | shadow 裁决落盘接线 | 真实系统三发言人密集消息 → 产生 decision 记录，两侧门限/Q 均为数值，同一结论不重复落盘 | 织入点 + 去重 |
| **TUNING-10** | AIMD 双轨目标 | `target:'both'` 时 `minBurstRate` 与 `thetaMin` 各走一步，`minDiscussionMessages` 只加一次，衰减只算一次 | shadow 对照公平性 |
| **TUNING-11** | `LOW_DENSITY` 按质量分连续步进 | `q=0.15` → `thetaMin +2.625` / `minBurstRate +0.44`；`q=0.45` → `+1.875` / `+0.32`：判废越狠收紧越多；`both` 目标两侧各走自身步进、`minDiscussionMessages` 仍只 +1；评分缺失 / `NaN` / 非数值退化为原固定 `+1.5` / `+0.25`，越界评分夹到 `[0,1]`；`FRAGMENTED` / `NOISE_SPAM` / `HIGH_QUALITY` 与评分无关 | `updateParameters` 条件步进断言 |
| **GATE-06** | 调度质量门跳过 | `trigger.dispatchMargin=1.3`、`potentialPeak={quality:21,burstThreshold:20}`、`partial:false` | 不调 judge、不调 dispatcher、零词条；info 日志含 `peakQ=21.000 < 26.000 = Θ_burst 20.000 × 1.3`；`recordDiscard(kind:'GATE', qualityScore:21)`；门限零步进、无 AIMD 快照 | `handleQuiescence` 真系统 + 手工注入峰值 |
| **GATE-07** | 关闭与软切片不受影响 | `dispatchMargin=0`（Schema 默认）与 `partial:true` | 同一份「勉强过阈」峰值照常走 judge + dispatcher；软切片仍只走原 AIMD 隔离日志 | 同上 + `Config({}).trigger.dispatchMargin === 0` |
| **GATE-08** | `GATE` 留证可回放 | `dispatchMargin=1.3` 跳过轮次 | 落一份 `.patchouli/discards/<date>-<sessionId>.json`，`readDiscardDump` 读回 `verdict.kind==='GATE'`、`qualityScore` 为峰值、无 `discardReason`、`recordedAt` 为数值、消息条数与会话一致 | `listDiscardDumps` + `readDiscardDump` |
| **MASK-12** | 双链人名精确替换 | `[[夜]]` 替换成假名、`[[数值膨胀]]` 原样保留、复合昵称各自映射 | 结构优先（ADR-019） |
| **LONGIMAGE-09** | 双链渲染 | 人名双链剥括号后包 chip，概念双链保留 | 正文与脱敏同源 |
| **LONGIMAGE-06** | 降级链共用同一份脱敏视图 | 长图截图整体抛错 → 返回 `null` → 短卡出图，短卡 HTML 不含真实昵称与号码；控制组喂原始视图必须泄露（证明渲染器本身不脱敏、脱敏只在插件侧做一次） | 假 page 渲染链 |
| **LONGIMAGE-07** | 看板娘底图内联为 SVG 位图 | 默认版式各有一层 `.mascot-bust` / `.mascot-reading`，位图是 `data:image/webp;base64` 内联（两处），无 `<script>`、无 `http(s)` 外链、无 `<path>` 描摹；`mascot:false` 时两层与内联位图全部消失 | `renderEntryLongImageHtml` 结构断言 |
| **LONGIMAGE-08** | 正文假名同样包 chip | 视图不携带参与者时，只被综述提到的假名靠 `knownNames` 透传才有 `.nm` 特殊渲染；不喂名单则退化为纯文本 | `renderEntryLongImageHtml` + `collectKnownNames` 外部名单 |
| **SCRIBE-04** | 熔断后宿主删档 | 熔断触发 `onManualSessionEnd('fuse')` → 宿主删除 jsonl 与水位元数据 → 目录清空 → 重启 `restored=[]` | 端到端 |
| **SCRIBE-05** | 结束回调异常隔离 | 宿主回调抛错只进 `onError`，会话照常结束 | `notifyManualSessionEnd` try/catch |
| **SCRIBE-STORE-07..10** | 水位 / 范围 / 往返 | `triggerOptions` 三键磁盘往返不丢（非法 `triggerMode` 与非数值 `rhoMin` 丢弃、不抛）；meta 单调水位与「无提示不写」；125 条 + 水位点 → 只装载 5 条且 `lastSettledTime` 回填；`enabled=false` / 非白名单 / 私聊三种拒绝文案 | `LocalStore` / `ScribeStore` |
| **SCRIBE-STORE-01..06** | 录制存储契约 | 追加写字段完整且无 `raw`；2000 码点截断（代理对安全）；10 并发不丢行保序；不足 2 条的脏文件被删；解析失败的文件保留不恢复且告警；删除幂等；白名单为空时 fail closed；`scribe/` 不被 `ensureWikiLayout` 预建 | `src/plugin/scribe.ts` 单元测试 |

## 定性验收期望检查清单 (Acceptance Checklist)

> 复核基准：线上运行 24 小时后重新发起校验。

### 一、触发感知维（前端漏斗）
1. **长静默零残留**：连续静默 $\ge 30\text{min}$ 后的首波多人群聊（$\ge 3$ 人、短句交替），状态机必须在 $\le 90\text{s}$ 内由 `IDLE` 切入 `BURSTING`，不得因前序高基线阻断。
2. **慢热讨论无漏检**：消息速率从 $2\text{/m}$ 梯级递增至 $6\sim 8\text{/m}$ 的渐进式争论，必须在突破物理门限（$\approx 6\text{/m}$）时捕获，不得出现基线同步跟涨导致门限溢出至 $>11\text{/m}$。
3. **极端峰值防穿透**：高频讨论（$\ge 11\text{/m}$）期间，突发触发门限强约束在天花板 $\le 10.8\text{/m}$，严禁出现 $15\sim 28\text{/m}$ 的脱轨阈值。
4. **低频单调收敛**：日间峰值回落后的闲聊期（$\le 3\text{/m}$），基线必须在 15 分钟内单调下降至 $<3.5\text{/m}$，无滞回死锁。

### 二、迟智与交付维（状态机周期）
5. **讨论完整性与软切片**：单次沉淀消息量稳定落在 $15\sim 120$ 条区间；超长讨论每满 120 条触发软切片交付，相位不重置，无消息截断与丢包。
6. **平息判定准确性**：群聊真正静止后，必须在 $300\sim 660\text{s}$（基础 300s + 动态语义加权）内触发 `onQuiescence`，不得出现永久卡在 `COOLING` 的悬停死锁。

### 三、沉淀与存储维（知识落盘）
7. **双轨数据自洽**：每次成功沉淀必须同时生成 `raw/sessions/<id>.json`（只读可信源）与 `wiki/debates/<id>.md`（双链词条），二者消息 ID 与时间戳严格对齐。
8. **索引增量闭环**：`data/llmwiki/index.md` 必须增量写入单行摘要，`data/llmwiki/log.md` 必须追加流水，且不破坏存量格式。
9. **静默舍弃透明度**：讨论消息不足（$<15$ 条）或纯水群触发的丢弃，必须完整上报 `onDiscard` 诊断日志（含 `messageCount`、`peakRate`、`reason`），并在 `.patchouli/discards/` 留下该轮消息全集与判定依据（`kind` 区分 `MODEL` / `FLOOR` / `FAILURE` / `GATE`），不得静默吞没。

---

## 补充登记：2026-11-11 全量审计补齐的用例

> 本节收录此前只在测试文件里存在、未登记到规格表的用例（`本次审计发现 62 条 CDC 漂移`）。
> 描述列取自测试标题，断言细节以测试文件为准；后续新增用例请直接并入对应模块表。

| 用例 | 覆盖点 | 文件 |
| :--- | :--- | :--- |
| **ALBUM-09** | 隐藏 Bot（chatluna-sandbox 之类模拟实例）不参与探测，零动作调用 | `albums.test.mjs` |
| **API-CARD-02** | 宿主没有 puppeteer 时返回 503 且不伪造图片 | `api-card.test.mjs` |
| **API-CARD-03** | 有 puppeteer 时出 JPEG 长图，且渲染内容已脱敏 | `api-card.test.mjs` |
| **API-CARD-04** | 图片匿名化开关读写：默认开启、可关闭、未知字段丢弃、非法体型 400 | `api.test.mjs` |
| **CARD-SETTINGS-01/02** | 出图选项落盘（缺文件默认脱敏、关闭跨重启存活、损坏/未知版本退回默认）与布尔归一化 | `card-settings.test.mjs` |
| **API-TRAFFIC-01** | /api/status 与 /api/series 回传 traffic + sampleMs + serverTime | `api.test.mjs` |
| **API-TOPIC-01** | 主题校准参数读写、夹紧与只读状态 | `api.test.mjs` |
| **API-TOPIC-02** | 手动主题校准按目标群扇出、force 透传并返回逐群结果 | `api.test.mjs` |
| **API-TOPIC-03** | 无 channelId 的批量校准只跑订阅目标（不碰 `config.channels` 旧群与库内历史群） | `api.test.mjs` |
| **CARD-07** | 每周相册总结一页列出主题，不复制正文，PNG 裁剪到实际高度 | `card-delivery.test.mjs` |
| **DELIVERY-BATCH-02** | 服务只有 deliver、没有 broadcast → NO_BROADCAST，不退化逐个投递 | `delivery-batch.test.mjs` |
| **DELIVERY-BATCH-03** | 无投递服务时结构化失败，不抛出 | `delivery-batch.test.mjs` |
| **DELIVERY-BATCH-04** | 空目标表直接成功返回，不发任何请求 | `delivery-batch.test.mjs` |
| **PROTOCOL-05** | 流式读取超时归类为可重试传输失败，而不是「响应不可解析」 | `dispatcher.test.mjs` |
| **DISPATCH-07** | provider 二值归一化与通道语义（历史 `auto` / `standalone` 兼容） | `dispatcher.test.mjs` |
| **DISPATCH-08** | 历史配置 + Gemini 端点自动探测原生协议 | `dispatcher.test.mjs` |
| **PROTOCOL-06** | Gemini URL 归一化与请求体形状（systemInstruction / contents / generationConfig） | `protocols.test.mjs` |
| **PROTOCOL-07** | Gemini 响应解析（parts 拼接、usage、MAX_TOKENS、blockReason） | `protocols.test.mjs` |
| **PROTOCOL-08** | 协议注册表与自动探测链顺序 | `protocols.test.mjs` |
| **PROTOCOL-09** | auto 探测在 404 时顺延协议并缓存结果 | `protocols.test.mjs` |
| **PROTOCOL-10** | Gemini 端点自动走原生协议并把生效协议透出自检 | `protocols.test.mjs` |
| **PROTOCOL-11** | 降级边界：凭据 / 限流 / 显式协议都不切换协议 | `protocols.test.mjs` |
| **ENTRY-DELIVER-02** | 配置改道后只发该群聊天，相册列表被忽略 | `entry-delivery.test.mjs` |
| **ENTRY-DELIVER-03** | 改道目标允许带平台前缀，且不会重复加前缀 | `entry-delivery.test.mjs` |
| **ENTRY-DELIVER-04** | 非法与重复的相册目标被丢弃 | `entry-delivery.test.mjs` |
| **ENTRY-DELIVER-05** | 既无相册也未改道时返回空表（调用方据此告警） | `entry-delivery.test.mjs` |
| **GATE-01-PLUGIN** | 低概率时跳过云端调度并落 MODEL/LOW_DENSITY 留证 | `judge-gate.test.mjs` |
| **GATE-01-PLUGIN** | 高概率与不可用都必须照常调度云端大模型 | `judge-gate.test.mjs` |
| **MASK-11** | 单字中文名在提及语境里必须替换（结构化字段同样） | `mask.test.mjs` |
| **MEDIA-IDLE** | upstream headers do not disable response-body idle timeout | `media-proxy.test.mjs` |
| **MEDIA-IPV6** | public literal is pinned without DNS and streams bytes unchanged | `media-proxy.test.mjs` |
| **MEDIA-IPV6-MAPPED** | IPv4 映射字面量在字面量直通分支即拒绝，不进 DNS / pinnedLookup / fetch | `media-proxy.test.mjs` |
| **RICH-02-MAPPED** | IPv4 映射 IPv6 字面量（十六进制 / 全展开 / 大小写混写）判定为私网 / 不可用 | `rich-message.test.mjs` |
| **QQ-VIDEO-CARD** | mini-app detail_1 qqdocurl is retained as a navigation link | `qq-video-card.test.mjs` |
| **QUOTE-FAILURE** | 真正的通道故障仍然告警并标记解析失败 | `quote-unavailable.test.mjs` |
| **FORWARD-FAILURE** | 真正的合并转发通道故障仍然告警并标记解析失败 | `quote-unavailable.test.mjs` |
| **RICH-10** | OneBot reply 后面自动附加的被回复内容镜像文本不被重复渲染 | `rich-message.test.mjs` |
| **SCRIBE-STORE-02** | 并发 10 次 append 不丢行、不互相覆盖 | `scribe.test.mjs` |
| **SCRIBE-STORE-03** | 启动恢复 15 条会话，不足 2 条的残留被删除 | `scribe.test.mjs` |
| **SCRIBE-STORE-04** | 解析失败的记录保留文件、告警且不恢复 | `scribe.test.mjs` |
| **SCRIBE-STORE-05** | 删除幂等，记录目录缺失时恢复不抛错 | `scribe.test.mjs` |
| **SCRIBE-STORE-06** | 管理员白名单默认 fail closed，未登记用户一律拒绝 | `scribe.test.mjs` |
| **SCRIBE-STORE-08** | 已交付水位随消息行落盘、只进不退，删除时一并清理 | `scribe.test.mjs` |
| **SCRIBE-STORE-09** | 恢复只装载未交付部分，水位写回 lastSettledTime | `scribe.test.mjs` |
| **SCRIBE-STORE-10** | logon 范围校验——插件停用 / 非白名单群明确拒绝 | `scribe.test.mjs` |
| **TELEMETRY-10** | potential 模式闸门读 Θ_burst 与 ρ_min（不退回速率门限） | `telemetry.test.mjs` |
| **TOPIC-SCHED-02** | 未到 04:00 不触发，过点后补跑 | `topic-scheduler.test.mjs` |
| **TOPIC-SCHED-03** | 模型失败当天按 30 分钟退避重试，成功后封盘 | `topic-scheduler.test.mjs` |
| **TOPIC-SCHED-04** | runNow(force) 无视日切水位，force 透传给聚合器 | `topic-scheduler.test.mjs` |
| **FILTER-01** | 物理层剥离 Satori/CQ 码并过滤纯表情/单字/标点刷屏 | `trigger.test.mjs` |
| **FILTER-02** | 有效速率按窗口折算，信息熵率暴露复读 | `trigger.test.mjs` |
| **DYNQ-01** | computeDynamicQuiescence 四类语义信号按 1.2~2.2 倍延长 | `trigger.test.mjs` |
| **DYNQ-02** | BURSTING 接近平息时按末尾语义延长 quiescence | `trigger.test.mjs` |
| **FREEZE-01** | 突发期基线绝对冻结，结算后解冻 | `trigger.test.mjs` |
| **SLICE-01** | 缓冲区达到 120 条触发软切片且相位不变 | `trigger.test.mjs` |
| **TUNING-04** | 高价值讨论才放宽，且舍弃判定优先于评分 | `tuning.test.mjs` |
| **TUNING-05** | 硬限幅恒成立（minBurstRate 3~8 / minDiscussionMessages 6~16 / thetaMin 10~60） | `tuning.test.mjs` |
| **TUNING-06** | 初始状态与非法输入收敛到锚点/默认值 | `tuning.test.mjs` |
| **WIKI-EDIT-01** | removeIndexEntry 删除全部同标题托管行并保留脚手架与用户分区 | `wiki-edit-delete.test.mjs` |
| **WIKI-EDIT-02** | removeLogEntry 删除全部同标题流水行并保留标题脚手架 | `wiki-edit-delete.test.mjs` |
| **WIKI-DELETE-01** | deleteEntry 精确删除单个词条的文件/原始 dump/索引/流水，且幂等 | `wiki-edit-delete.test.mjs` |
| **WIKI-DELETE-02** | deleteEntry 省略 title 时从词条 H1 反推标题 | `wiki-edit-delete.test.mjs` |
| **WIKI-DELETE-03** | 删除不存在的词条不创建 index.md / log.md / 目录 | `wiki-edit-delete.test.mjs` |
| **WIKI-DELETE-04** | 并发删除与写入走同一串行队列，索引不丢更新 | `wiki-edit-delete.test.mjs` |
| **WIKI-DELETE-05** | 标题漂移时同时清理新旧标题的索引 / 流水行 | `wiki-edit-delete.test.mjs` |
| **WIKI-CLEAR-01** | clearAllEntries 清空词条与 raw，重置索引/流水，保留目录与非托管文件 | `wiki-edit-delete.test.mjs` |
| **WIKI-CLEAR-02** | 空目录 clearAllEntries 会建全骨架并返回 0 | `wiki-edit-delete.test.mjs` |
| **WIKI-UPDATE-01** | updateEntryMarkdown 写正文并按元数据同步索引（含标题迁移） | `wiki-edit-delete.test.mjs` |
| **STORE-DELETE-01** | deleteEntry 删除单条元数据并持久化，保留 cadence 与其他词条 | `wiki-edit-delete.test.mjs` |
| **STORE-UPDATE-01** | updateEntry 局部更新字段、刷新 updatedAt 并原子持久化 | `wiki-edit-delete.test.mjs` |
| **STORE-UPDATE-02** | 并发 update / delete 在串行队列内不互相覆盖 | `wiki-edit-delete.test.mjs` |
| **STORE-CLEAR-01** | clearEntries 清空词条但完整保留 cadence 调优参数 | `wiki-edit-delete.test.mjs` |
| **SYSTEM-DELETE-01** | PatchouliKnowledgeSystem.deleteEntry / clearKnowledgeBase 编排全链路 | `wiki-edit-delete.test.mjs` |

### 管理面来源校验 / 路由守卫回归 (AUTH-18 ~ 21 / API-AUTH / API-OBS / API-TUNE-04)

| 用例 ID | 场景描述 | 预期结果 | 底层判定机制 |
| :--- | :--- | :--- | :--- |
| **AUTH-18** | 直连对端非 loopback 时 XFF 不可采信 | 公网对端自填 `X-Forwarded-For: 127.0.0.1` 仍 423，内存与磁盘都不落定密钥；内网直连忽略 XFF 只判对端；对端为 loopback 时取最右一跳（左侧伪造值无效） | `allowsBootstrapFrom` + `handleBootstrap` |
| **AUTH-19** | `/session` 不回显长期令牌 | `via==='token'`（`x-api-token` / `Bearer <apiToken>` 直连）时 `session` 与 `expiresAt` 均为 `null`；`via==='session'` 仍回显短票据 | `handleSession` |
| **AUTH-20** | 并发首次初始化 | 断言 20：只有第一个请求成功，第二个 409 `already-initialized`，落盘文件保持第一个请求的密钥，不被覆写 | `handleBootstrap` 占位顺序 |
| **AUTH-21** | 落盘失败回滚占位 | 写入不可用路径时 500 `persist-failed` 且 `authority.configured === false`，换合法路径可重新初始化 | `TokenAuthority.revertConfiguration` |
| **API-AUTH-01** | 宿主 router 缺少 `use` | 不注册任何 `/api/*` 路由（逐一核对 entries / status / channels / prompt / tune / clear / topics），并发出含路径与 `use` 的告警；页面壳 / `/session` / `/login` / `/bootstrap` 照常注册 | `registerWebUi` 注册闸门 |
| **API-AUTH-02** | 守卫真实参与请求链 | 替身 router 记录 `use('/patchouli/api', guard)`；无凭据请求被中间件拦成 401 `{error:'unauthorized',reason:'missing'}`，带 `x-api-token` 才穿透到业务处理器 | 中间件链 + `createApiGuard` |
| **API-OBS-01** | `/api/status` 可观测性能力探测 | 宿主缺 `shadowLedger` 时 `observability` 回 `{written:0,failed:0,lastWriteAt:null}` 且整体仍 200；有台账时透传真实计数 | `readLedgerStats` |
| **API-TUNE-04** | `/api/tune` 异常归类 | 宿主抛 `RangeError`（非法取值）回 400；其余 `Error` 仍回 500，且响应体 `ok:false` 带错误信息 | `POST /api/tune` 错误映射 |
| **AUTH-22** | 会话表落盘 | 重启后同一票据仍有效；文件只存哈希，不含票据原文 | 不再要求每次重启重新登录 |
| **AUTH-23** | 7 天有效期与轮换 | 默认 TTL = 7 天；换 apiToken 后旧票据整批失效；过期票据重启不复活 | 安全边界 |
