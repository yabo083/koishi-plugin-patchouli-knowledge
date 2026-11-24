# 订阅表与控制台高级设置

> **实现现状（0.8.72+）**：本文是 0.8.60 的方案稿，字段与实现有差异。现行契约见
> `src/plugin/README.md` §3.5.2：行形状为 `{ source, targets: string[], entry, weekly }`
> （**多值目标**，元素只有两种：`@chat` 或相册的**唯一可读名**——可读名在**保存时**按当时
> 的候选解析成 `群号/相册ID`，写进 `settings.json` 顶层的 `targetBindings`（名字 → 地址），
> **投递期只查这张绑定表**，查不到即停投并 warn，绝不按当前候选猜；升级前直接写在 yml 里的
> 稳定地址 `群号/相册ID` 仍按形状兼容；
> 下拉另带 `#group:<群号>` 的不可选分组标题，它不是目标、归一与解析都跳过；历史单值 `target`
> 读取时归一成 `targets: [target]`）。
> **编辑入口是 Koishi Console 的插件配置页**（保存写回宿主 `config.subscriptions`，即 `koishi.yml`）；
> `<wikiDir>/.patchouli/settings.json` 顶层的 `subscriptions`（+ `targetBindings`）覆盖层由
> `POST /api/subscriptions` 写入，优先级高于 `koishi.yml`——但**浮窗没有订阅编辑页**，该接口目前
> 未接到任何 UI。下文出现的 `listen` / `weeklyCron` / `weeklyAlbum` 等列并未实现。

**方案，基线 0.8.60；不改变阅读器页面。** Koishi 插件配置页首屏只留「讨论沉淀总开关」「订阅表」和一个默认收起的「高级设置」入口。订阅表一行可以监听一个群，将其词条发到群聊，将其周报发到另一个相册；也可以只监听，不向任何地方发送。**旧周报不是分群周报**：迁移要同时保住它的全库选材和全部接收相册，不能只迁移一份相册 ID 列表。

## 1. 表与路由契约

`subscriptions: Schema.array(Schema.object(rowFields)).role('table').max(1024).default([listenAllOnly]).description('每行配置一个来源与目标；清空后不监听、不投递。')`。`listenAllOnly` 是完整数据行 `{ source: '*', listen: true, target: '', entry: false, weekly: false, weeklyCron: '', weeklyAlbum: '' }`。首次安装默认**显式展示这一行**：保留原来无配置时监听所有群、不对外投递的行为。删除最后一行得到 `[]`，与此默认值不同，不是恢复出厂设置。不能把整表默认值改为 `[]`，然后靠 `rows.length === 0` 判旧配置。

以下为 `rowFields` 的全部七列；“说明”列是对应链尾 `.description('…')` 的精确文本。示例中的 `101`、`202` 等仅为离线 fixture。

| 字段 | 类型与 Schema（含默认值） | 说明 |
|---|---|---|
| `source` | `string` · `Schema.string().max(256).default('')` | 来源填群号，`*` 表示所有群，`=原频道ID` 表示精确匹配旧频道。 |
| `listen` | `boolean` · `Schema.boolean().default(true)` | 开启后监听来源群，关闭本行不会撤销其他行的监听。 |
| `target` | `string` · `Schema.string().max(256).default('')` | 目标填群号或 `群号/相册ID`，留空不投递到该列。 |
| `entry` | `boolean` · `Schema.boolean().default(false)` | 开启后将该来源的新词条立即发到目标。 |
| `weekly` | `boolean` · `Schema.boolean().default(false)` | 开启后发送该来源最近七天的主题周报，来源为 `*` 时选取全库。 |
| `weeklyCron` | `string` · `Schema.string().max(128).default('')` | 周报时间填五段「分 时 日 月 周」，留空继承默认时间（上海时区）。 |
| `weeklyAlbum` | `string` · `Schema.string().max(256).default('')` | 周报改投相册时填 `群号/相册ID`，留空沿用本行目标。 |

- 裸群号是十进制**字符串**，不转 JS `number`。目标外围去空白；相册只接受一个 `/`，两段均非空，ID 是不带空白、控制字符或 `/` 的不透明串，保持大小写。群目标编译为 `{kind:'channel',channelId:'onebot:<群号>'}`，相册再带 `kind:'album',albumId`。新输入中 `private:`、`*`、缺段和多段均不是目标；不得当成群聊、默认目标或广播。行内不嵌套对象，不放动态 Schema。
- 每行必须有来源；新增后没填完的行可留在编辑器，不可提交。`entry` 开且 `target` 空、`weekly` 开且 `weeklyAlbum || target` 空、非空的覆盖相册非法，均报行号和字段；**没有“目标留空就发回来源群”的隐式规则**。`weeklyCron` 非空必须是 delivery 支持的五段语法；不能悄悄回落到默认日程。`advanced.weeklyCron` 默认 `DEFAULT_WEEKLY_CRON = '30 4 * * 1'`；无论哪个来源都用 `Asia/Shanghai`。
- 来源 `*` 表示所有非私聊；`=…` 与实际 `session.channelId` 逐字匹配（不 trim、不去前缀）。普通群号匹配对应 OneBot 群；来源比较可兼容裸号、`onebot:<号>`、`onebot:group:<号>`，不能把私聊末尾的数字当群号。外发时必须给出真实来源，不传来源不能命中 `*`。新提交的具体群监听限定在适用适配器，迁移的精确监听保留旧 `channels.includes(session.channelId)` 行为。
- **三条独立规则**：监听集合由所有 `listen=true` 行并集决定；已监听来源产生的新词条只发给**命中该来源且 `entry=true`** 的目标；周报只看 `weekly=true` 的行，可针对已存的主题，即使今天不监听该来源也能发。`listen=false` 不是全局否决。明确填写跨群目标才允许跨群。`target` 和 `weeklyAlbum` 都不是监听授权。
- 示例：`101 | 开 | 202 | 开 | 开 | 留空 | 303/a` 监听 101，词条到 202 聊天，周报只含 101 的主题并发到 303/a。旧式全库周报行则是 `* | 关 | 303/a | 关 | 开 | 留空 | 留空`：给此相册发全库周报，**不因此监听所有群**。同一个来源/目标可有多行；执行键按动作与规范化地址去重，不按行号。调换行序不改变权限或投递集合。

## 2. 迁移：先读原始键，再应用 Schema 默认值

提议新建 `src/plugin/subscriptions.ts`。三个边界不同：**迁移**只做旧→新，**编译**把新表变成索引，**持久化**由配置所有者在确认保存时完成。函数签名为设计契约，不是已实现 API：

```ts
interface SubscriptionRow {
  readonly source: string; readonly listen: boolean; readonly target: string;
  readonly entry: boolean; readonly weekly: boolean;
  readonly weeklyCron: string; readonly weeklyAlbum: string;
}
interface SubscriptionDocument {
  readonly subscriptionVersion: 1;
  readonly subscriptions: readonly SubscriptionRow[];
  readonly advanced: { readonly weeklyCron: string };
}
type MigrationResult =
  | { readonly ok: true; readonly value: SubscriptionDocument; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly path: string; readonly reason: string };
function migrateSubscriptions(rawPluginBlock: unknown): MigrationResult;
function compileSubscriptions(doc: SubscriptionDocument): SubscriptionSnapshot;
```

`unknown` 入口检查普通对象、字符串、数组、布尔；不猜测 `null`、错型或未知版本。旧字段的**业务默认**为 `channels=[]`、`albums=[]`、`entryEnabled=true`、`entryRedirectChannelId=''`、`cron=DEFAULT_WEEKLY_CRON`。采用原始属性存在性，而不是对已填默认值的 `config` 调 `hasOwn`。`schemastery/src/index.ts:409–423,790–795` 会克隆缺省值，包括数组的内建 `[]`；Cordis 在进入 `apply` **之前**调用 Schema（`@cordisjs/core/src/registry.ts:187–195`）。

```text
migrate(raw):                                  # 不写输入，不读文件、时钟或相册候选
  v = raw.subscriptionVersion
  if v 存在且不是 1: 返回错误；不按旧版处理
  if v == 1 或 raw 自有 subscriptions 键:
      校验 raw.subscriptions（仅 v1 且键缺失时取 [listenAllOnly]）
      用 advanced.weeklyCron 或常量；不访问 channels、albumDelivery 的任何子键
      返回 v1 完整数据；不与旧表拼接
  C = 旧 channels；A = 顺序解析并去重的旧 albums；R = trim(旧改道)；E = 旧 entryEnabled
  W = 旧 cron 归一；空白用常量；非空无效值保留诊断，不给它安排默认任务
  rows = []
  if C.length == 0: 加 (*, listen=开)，其余动作全关
  else: 对 C 中每个不同的非空字符串 c 加 (=c, listen=开)，逐字保留 c
  # C=[''] 与 C=[] 不同：前者无人可监听，绝不生成 *。
  if E and R 非空:
      对 C 中每个有效精确来源（C.length==0 时仅 *），加 (来源, target=R, entry=开)
  else if E:
      对每个 A 中的 g/a：若 C 为空或 C 中确有末段为 g 的可监听来源，
          加 (匹配该旧来源的选择器, target=g/a, entry=开)
  对每个 A 中的 g/a，无论 g 是否在 C 中、是否改道、E 是否开启：
      加 (*, listen=关, target=g/a, weekly=开)   # 全库；不走新词条的同群过滤
  所有仅投递行 listen=关；其他未指定开关为关，覆盖列为空
  同来源、同目标、同覆盖的行可合并开关（逻辑或），不改变首次出现顺序
  返回 {subscriptionVersion:1, subscriptions:rows, advanced:{weeklyCron:W}}
```

**旧词条匹配的实现细节。** 在 `C` 有限时，按旧 `planEntryTargets` 的 `groupIdOf(c)`（trim 后取最后一个 `:` 之后）索引 C，再对精确的 `=c` 建路由；不要对所有 C × A 造行。C 为空时只有 `*` 的**监听**，每个相册的**词条**路由仍须限定为它自己的群，绝不能用 `* → 每个相册`。兼容导入识别裸群号和 OneBot 群前缀；`entryEnabled=false` 仅关词条，不关周报，改道只发一次聊天，不附送相册。`C=['']` 不开监听，但有相册时仍有全库周报。

**异常数据不冒充无损迁移。** 旧解析器本来就忽略的空相册/缺分隔符，跳过并记录字段位置；原值保留在原始配置。旧解析器曾比 QQ 目标文法宽（例如非 QQ 平台的改道），对可能实际正在投的旧值、超上限输入或不支持的适配器匹配不能一律当坏值丢掉：预检列出具体路径，**不写新格式、不切换版本、旧实例继续工作**。禁止拆成多个目标、改变收件人或静默截断。迁移支持的是本项目约定的 QQ 群/相册；不能承诺任意字符串能无损表达为 QQ 目标。若旧全群模式实际混入其他适配器且同号匹配有歧义，须在切换前用旧事件回放核对，而不是把外平台匹配引入新订阅。

**落在哪里、何时生效：**

1. 对每个插件实例单独处理原始配置块（包括嵌套 `group`、停用实例和不同 fork）。升级工具先对原始 YAML 节点只读预检，生成候选 diff；确认后在部署配置事务中仅补 `subscriptions`、`subscriptionVersion: 1`、`advanced` 相应字段，原有键、其他实例、注释、环境变量引用和密钥不展开、不打印。备份并校验原文件版本；有并发改动则中止，不覆盖。完成这一步后**第一次打开原生表单就看得到旧订阅**。内存转换本身不能改变 console 拿到的原始表单草稿，因此不能把“后台能投”当成表格已经迁好。
2. 兼容窗口内旧实例直接加载也应工作：在 Schema 入口捕获 `Object.hasOwn(raw,'subscriptions')`，再作默认值解析。例如在根 `Schema.intersect` 增加隐藏、`preserve=true` 的 `Schema.transform(Schema.any(), …)` 投影，仅返回内部的存在位（不是配置项、不是运行期可写状态）；可见对象仍声明上述表格。原始迁移工具直接读原始块。两条入口调用**同一**纯函数；已解析输入先凭存在位重建迁移所需的键视图，不从默认表推断“用户写过”。在 `PatchouliKnowledgeSystem.initialize()` 开头、`restoreTopicSettings()/readTopicSettings()` 同层调用 `restoreSubscriptions`，发布编译结果；不会改 `config` 或主动写 `koishi.yml`。未物化旧块只做只读兼容，提示先导入再编辑。首装只有 `{}` 与历史 `{}` 无法区分，两者均为显式默认的「全群只监听」，无需猜测。
   `subscriptionVersion` 的 schema 是 `Schema.number().hidden()`，**不设默认版本**，因此显式的 `1` 在简化配置时不会消失。存在位仅在 schema 计算结果中传递；投影须在默认值前拒绝自有但非数组的表（包括 `null`），避免它被补成默认通配行。部署工具保存的是原始 YAML 上的精确 patch，绝不把整份 resolved options 回写。
3. 新文档一旦有版本或表（包括 `[]`），旧 `channels`、`albumDelivery.{entryEnabled,entryRedirectChannelId,albums,cron}` 仅作为**回滚原文**隐藏声明并在宿主正常保存时原样带回，运行时不再读取，绝不“新表为空就回退”。若 v1 用户把表重置成出厂值，console 可省略该键；版本仍在，语义为 `[listenAllOnly]` 而非重新导入。普通清空存为 `[]`。旧字段不是新版镜像；两来源不同周报等不能反投影到 0.8.60，不声称旧版能执行新规则。回滚使用切换前备份；退出兼容窗口须各实例均完成物化，另行公告，不能运行期清理原配置。
4. 对任一迁移成功的原始块 `x`，令 `d=migrateSubscriptions(x).value`，则 `migrateSubscriptions(d).value` 与 `d` 深相等；无需适配或填旧字段。再次保存不新增行、顺序或 cron。版本、表、全局默认值必须作为一个配置变更提交，不能先改版本再“后台补表”。

## 3. subscriptionRuntime 与实际接线

**实现前的不变量：** ① 宿主 `config` 从构造到卸载逐字节不变，订阅只由这一份配置文档持久化；② 同一次消息/计划在同一个不可变快照上同步决定来源与目标，慢 I/O 不决定是否获得授权；③ 更新是按实例、按单调 revision 全量替换，删行立即撤销，新版本不能被迟到的旧恢复或 cron 回调覆盖；④ 去重以业务动作、内容来源及规范化目标为单位，与行序无关；⑤ 每实例至多 1,024 行，文本字段见 §1，迁移/配置入口总 UTF-8 上限 1 MiB，最多一个现役快照和每个不同 cron 一个 stop 句柄，替换/卸载即释放。

`subscriptionRuntime` 是 `PatchouliKnowledgeSystem` 私有的稳定持有器，含 `{ revision, current }`；`current` 存 `listenAll`、显式监听索引、词条的按来源路由、周报的按有效 cron 分组及目标集合（只保存标量，不持有 Session/Context/宿主配置引用）。不导出可变 `Set/Map`。`replaceSubscriptions(document)` 完整校验并在无 await 的一段内编译、递增 revision、交换引用；向本实例调度适配器显式传新 revision。正常 Console 保存由 loader 写入并重载 fork；如接入 Koishi 的配置热更新，回调将**整份**最新配置送该入口，不是改 `config.subscriptions[i]`。不为 Console 配置另立 `.patchouli/subscriptions.json` 或第二个可编辑 Web API。启动先置空快照，未 ready 不接收消息、不排程；旧异步任务在执行 I/O 后检查 revision/实例是否仍存活，交给 delivery 前再核对目标是否仍获准；已提交给下游的发送不能撤回。

| 文件 : 函数/位置（现行行号） | 现在读什么 → 改成读什么 |
|---|---|
| `src/types.ts:580` `PatchouliPluginConfig`；`src/plugin/index.ts:499` `Config`；`src/index.ts` 包入口 | 公开旧键 → 增订阅行及高级区输入类型，区分原始输入、解析后的业务视图及只读 v0 字段；保留命名导出，不新增 `default`。 |
| `src/plugin/index.ts:848–869,1032` `constructor/initialize/markWhitelistedChannelsMonitored` | 构造时在初始化前遍历 `config.channels` → 新快照发布后按显式监听源登记下一个完整 5 秒桶；通配监听随消息懒登记，目标群绝不因此登记；替换时同步撤销已移除来源的监测起点，不伪造静默零。 |
| `src/plugin/index.ts:2107–2152` `apply/channelScope/handleIncomingMessage/registerMessageListener`；`:1179` `onIncomingMessage` | 框架 `ctx.intersect` 与系统直入各自 `channels.includes` → 共用运行时 `acceptsSource`，先判非私聊、非空来源、沉淀开关，再查监听索引；直入也守门。保留 ready + `restoreScribeSessions` 完成后注册一次；消息热路径不等读盘。若需辨别适配器，入站只传精简平台标识，不保存 Session。 |
| `src/plugin/entry-delivery.ts:37` `planEntryTargets`；`src/plugin/index.ts:1330,1405,1806` `handleQuiescence/apply(setEntryCardSink)` | `albums + redirect + 可省略来源` 及两处全局 `entryEnabled` → `planEntryTargets(snapshot, sourceChannelId)`，来源必填，先确认来源在监听范围，再查精确/通配词条目标；无命中是正常静默，**在出图前**结束。每个词条只渲染一次，沿用 `patchouli:entry` 和原来的业务去重键，以及 `deliverCardToTargets`。去掉按全局改道打印日志。 |
| `src/plugin/index.ts:1877,1891` `applyAlbumSchema/refreshAlbumSchema`；`src/plugin/albums.ts:265` `albumSchemaUnion` | 候选由旧表/白名单取值 → **只探测订阅表里出现的监听群**（`*` 行或「表为空且旧白名单为空」才回退 `get_group_list` 的全量群，上限 40）；配置中已经使用的相册从新表两目标列取。候选 union 在 `apply()` 每次重载与每轮探测后原地替换 `inner.list`（`refreshSubscriptionTargets`），新相册不再需要重启进程；合并结果再经 `scopeAlbumCandidates` 过滤，表外群的历史缓存直接丢（只留 `configured` 点名的具体相册）。候选缓存只读、只能帮助抄写编号，离线或探测不到不影响已配置目标。沿用卸载保护；原动态 schema 若不再有消费者，移除注册，不保留假下拉。只读参考可直接列在配置外的运维说明中，或在已有有权查看的相册目录中查看；**不是第二张可编辑表**。 |
| `src/plugin/index.ts:1930,2027` `runWeeklyAlbumUpload/apply(ctx.inject)`；`src/plugin/weekly-schedule.ts:41` `registerWeeklyCron` | 全局一个 `cron`、`gateDailySlot('patchouli:weekly-album', minute)` 和全量 `albums` → 对开启周报的行按规范化 `weeklyCron || advanced.weeklyCron` 分组向 miyako-delivery 注册，每个表达式一个句柄；回调只跑该组。`ctx.inject` 负责晚到/重注入；变更同步撤销旧服务句柄并按新快照重建，dispose 全停且幂等。不自建 timer，不回落到 bot.sendMessage。 |
| `src/plugin/index.ts:1950–1993` `runWeeklyAlbumUpload`；`src/wiki/storage.ts:396` `getRecentEntries` | 旧 `getRecentEntries(undefined,500)` + 最近七天 topic 筛选 → 迁移 `*` 行**原样使用该查询和顺序**；具体来源先按保存的频道 ID 选记录、再限 500 条、筛近期 topic，再脱敏渲染。来源别名匹配多种存储 ID 时先按该来源合并排序再限 500，不能查全库前 500 再筛群。同一触发内按内容来源复用图，按 `weeklyAlbum || target` 调 `deliverCardPng`，原生支持群聊和相册。 |
| `src/plugin/index.ts:2004` `TopicScheduler.channels`；`src/plugin/scribe.ts:487` `scribeScopeRefusal` 与 `index.ts:2199` `startScribe` | 独立判断旧 `channels` → 使用同一个监听视图；仅 `listenAll` 时才用 `localStore.listChannels()` 枚举，不把“无人监听”解作“全部历史群”。书记员启动与入站一致，恢复时不得重新启用已移除来源。**每日校准与每行的周报投递不是同一开关**。 |
| `src/web/api.ts:913,1244,1281,1331` `registerWebUi` 的 channels/topics/status/series | 旧配置白名单 → 从快照读显式监听群/通配状态；阅读下拉仍可并入历史群，历史不会变成新监听权限。默认校准范围用与调度器相同的枚举，不因空表遍历全库。仅调整数据提供者，不重设计前端。 |

**周报幂等及生命周期。** 按行计算出 `(有效 cron, 内容来源, 实际目标)`，按 cron 合并句柄；同一分钟，同一个内容来源到同一个目标只投一次，哪怕两种表达式撞车、换行序或重启。不同来源到同目标是两份内容，不能误去重。旧的全局分钟闸会让第二个 cron 把自己跳掉，不能照搬。发送边界使用 delivery 的 Write-Ahead claim（`koishi-plugin-miyako-delivery/src/service.ts:135–153`），保留旧全库相册的 `scope='patchouli:weekly-album'`、`dedupeKey='<分钟桶>:<群号>/<相册ID>'`；新的具体来源用独立 scope 和无歧义编码的 `[分钟桶, 内容来源, 目标]`。不需要为每个历史行在 delivery 的日切槽表里永久创建一个 slot。限制同时渲染数（每实例一个进行中工作者；相同分钟/来源共用任务，有界待办队列最多 1,024 个轻量键，不缓存 PNG 历史，满则记可见错误）。卸载后迟到回调不注册任务、不发送；服务未就绪只待注入，不降级直发。

**`enabled` 的一个历史细节：** 0.8.60 的 `enabled` 是“讨论沉淀总开关”，守住入站和监测；旧 `ctx.inject` 的周报任务并未检查它。为无损升级，保留并在主区按此命名：停止整个插件才会卸下所有 cron；想只关周报，取消对应行的 `weekly`。不要把旧 `enabled=false` 的定时周报悄悄吞掉。

## 4. 原生折叠：支持 `.collapse()`，不是 `.hidden()`

查证范围：项目 `node_modules/@cordisjs/schema` **0.1.1**、`schemastery` **3.18.0**；项目未安装配置页客户端，客户端证据取自本机 `E:/Codes/Koishi/koishi-app/node_modules/` 的 Koishi **4.18.11**、`@koishijs/plugin-config` **2.8.6**、`schemastery-vue` **7.3.15**。以下是源码结论，不是本次已做线上 UI 验收。

| API | 源码证据与实际行为 |
|---|---|
| `.hidden()` | `@cordisjs/schema/src/index.ts:3–5` 直接重导出 schemastery；`schemastery/src/index.ts:315–323` 设置 `meta.hidden`；`schemastery-vue/src/schema.vue:2–5` 不渲染该项，`form.vue:51–60` 计算标题时也跳过。仍能接受旧配置，不存在可点开的隐藏设置。 |
| `Schema.object(…).description(…)` | `@koishijs/plugin-config/src/shared/packages.ts:81–98` 取导出的 Config/schema 给客户端；`dist/index.js` 使用 `k-form`。`schemastery-vue/src/extensions/object.vue:2–45` 非折叠时遍历命名字段，描述显示为标题；仅写 description 不会收起。 |
| `.collapse()` | `schemastery/src/index.ts:75–83,115–125,315–323` 明确提供 `collapse(value=true)`；`object.vue:22–37` 把 `meta.collapse` 传作 `collapsible.initial`；`base.vue:17–18,29–38,48–52,77` 用 `ref(initial)`、展开按钮/收起菜单和 `v-show`。**本地版本原生支持默认收起**，不是 `collapsed` 属性，也不是多个面板互斥的 accordion。折叠不改字段值。 |
| `Schema.intersect([...])` | 服务端 `schemastery/src/index.ts:716–733` 合并结果，客户端 `extensions/intersect.vue:2–16,20–42` 各子块绑定同一 `modelValue`；普通子项被传 `foldable:false`，父 meta 可能下传。不要指望 `intersect([main, advancedObject.collapse()])` 的平级匿名 object 一定会折叠，也不要在父级重复写标题。要把 `advanced` 作为**命名属性**挂到真正的 object 下面。 |
| `.role('table')` | `schemastery-vue/src/index.ts:94–104,124–136`：array 默认是可增删的分组列表；表格角色只匹配 array/dict 且行能 `toColumns`。`utils.ts:273–291` 支持 string/number/boolean、常量枚举和受支持的多选；`extensions/table.vue:8–27,53–97` 以字段描述作表头，有增删/排序。`@koishijs/client/client/components/index.ts:32–36` 把 dynamic 注册在 `type:'any'`；表格内部只用 `schema-primitive`，故相册 `Schema.dynamic(ALBUM_SCHEMA_KEY)` **不是可用表格列**。目标直接输入字符串。 |
| `.role('dict')` | `schemastery-vue/src/index.ts:94–115,124–136` 没有名为 `dict` 的原生角色；`schema.vue:166–176` 按 type/role/校验选组件，未知角色不能把 object 变成字典。`Schema.dict(inner)` 是真实的动态键值类型，默认分组编辑；`Schema.dict(inner).role('table')` 才是带可编辑键列的表格。本设计两者均不用。 |

**配置树：** `Schema.object({ enabled, subscriptions, advanced: Schema.object(advancedFields).description('高级设置').collapse(), …隐藏的旧键 })`。若做原始存在位投影，以上对象仍是根 intersect 中的一个完整可见子项；命名 `advanced` 不作为 intersect 的匿名直接子项。

- 主区不再摆管理员、模型、存储路径、素材池或周报全局参数。高级区包含 `adminUsers`、`weeklyCron`、`dispatcher`（保留 provider/条件分支、模型、协议、重试、采样与 Token 上限）、`security`、`media`、`storage`、`trigger`、`topics`、`query`、`judge`、`observability`、`notifyOnSummarized`。有意禁止在 Koishi 表单编辑的旧别名、废弃枚举和面板专属提示词继续隐藏；要让高级参数可编辑，就移除该字段原有 `.hidden()`，不要给 advanced 同时用 hidden 和 collapse。密钥保持 `role('secret')`。已存在的运行期主题/提示词覆盖按原优先级处理，折叠不改变权限或运行期优先级。
- **移动位置也要迁值**：在同一个原始配置事务中，对照 0.8.60 字段逐叶复制到 `advanced.<原路径>`，只有新路径显式存在才优先（包括 `false`、`0`、`''`）；不能用 schema 默认值覆盖旧自定义值或整个替换 `dispatcher`。解析后建立一份只读业务 options 适配现有消费方，业务不同时尝试从两个位置取值。`dispatcher` 的首默认分支仍不可 `required()`，保留旧枚举以通过校验。原路径兼容窗口与订阅相同。当前 `src/plugin/index.ts:415–497,499–614` 是字段清单，不以陈旧 README 的 `topicDelivery` 命名为准。

## 5. 可执行验收清单

以下均是**拟新增或扩展**的用例，不是测试结果。测试跑已编译插件、真实 `Config`、`LocalStore`、可控时间与临时目录；纯规则直接断言结构，投递集成可用实际 miyako-delivery 持久层与离线收件端，禁止向真实群试发。

| 名称（`tests/*.test.mjs`） | 输入 → 可观测断言 |
|---|---|
| `SUB-MIG-01 whitelist-albums-no-cartesian` | `channels=['101','202']`, albums `101/a,101/b,303/c` → 只监听 101、202；101 词条发 a、b，202 不发，303 不因 c 入监听。全库周报目标仍为三个。 |
| `SUB-MIG-02 wildcard-is-not-fanout` | `channels=[]`, albums `101/a,202/b`；回放 101、202、999 → 全接受，词条分别为 a、b、无；`channels=['']` 回放则全拒，周报仍可发。 |
| `SUB-MIG-03 redirect-and-entry-off` | 改道 `onebot:909` + 两相册 → 每个允许的来源只投 909 聊天；再设 `entryEnabled=false` → 无词条投递；两次全库周报对象、目标与 cron 不变。 |
| `SUB-MIG-04 full-library-weekly` | 真实临时库含 101、202、未在白名单的历史群 303 的近期主题、过期主题和普通词条；`C=['101']`、接收相册 `202/b,303/c` → 两相册均收到同一组全库近期主题 ID；排除旧主题/非主题，不因来源或接收群裁剪。对比旧 `getRecentEntries(undefined,500)` 结果。 |
| `SUB-MIG-05 raw-presence-and-roundtrip` | 分别回放旧无键、v1 明写 `[]`+旧键、v1 省略默认表、旧键+无版本但显式 `[]`，再跑真实 `Config` 解析及简化/存盘/重启 → 旧默认只监听，显式空表均零监听零外发，v1 默认仅一条 `*`；删除最后一行保存不复活旧表。 |
| `SUB-MIG-06 idempotent-and-readonly` | 冻结旧配置与嵌套数组，做两轮迁移/序列化/重载 → 行、顺序、cron、版本一致；v1 提供旧键的 throwing getter，纯迁移不访问它；正常配置原文及秘密不进日志也不被修改。 |
| `SUB-MIG-07 legacy-replay` | 用脱敏 0.8.60 原始 YAML（非默认 cron、改道、空白/重复相册、多个 fork、旧 dispatcher 与高级参数）及离线来源事件，分别过旧版/新版真实规划器与库查询 → 比较监听集合、每条事件的实际目标、每相册周报内容/次数；第二次物化无差异。不能表达的活动目标导致预检失败、原文件不变。 |
| `SUB-ROW-01 chat-and-album-override` | §1 示例行 → 101 新词条只发 `onebot:202`，周报只选 101 并投 `303/a`；清除覆盖后周报投 202 聊天，词条结果不变。 |
| `SUB-ROW-02 switches-and-dedup` | 对 `listen/entry/weekly` 的全部八种组合测试，另加入重叠 `*` 与重复目标 → 未监听来源绝不产词条，仅周报行可发存量；同来源同内容同目标仅一次，行重排不换结果。私聊、空来源和只作为 target 的群均不被额外放行。 |
| `SUB-ROW-03 fail-closed` | 残缺行、非法 `weeklyAlbum`、未知版本、10 MiB 单字段、超过 1,024 行 → 校验错误带路径，既不激活部分表也不扩大监听；不 stringify 原载荷、不注册任何新增句柄，旧快照不变。 |
| `SUB-CRON-01 groups-and-collisions` | 一行继承、一行覆盖，两表达式撞在同一分钟，另有关闭周报行 → 只注册有效分组；共用目标同内容跨组/重启不重复，异内容/异目标均送达，关闭行无调用；非法表达式不改期。 |
| `SUB-HOT-01 reload-during-render` | 旧渲染慢 5s，中间删目标、加新行、重载 delivery，再放行旧渲染 → 旧接收端零次，只有一个现役句柄/表达式；宿主 config JSON 全程不变，重启读取同一策略。卸载后迟到回调不能注册 effect 或外发。 |
| `SUB-SCOPE-01 listener-scribe-topics` | 真实系统只监测 101，后换成空表 → 入站/流量桶/书记员启动/每日默认校准范围一起变更，已存历史仍可查但不再被默认校准；循环替换、消息连发和服务反复注入后，旧索引与 cron stop 句柄不增长。 |
| `SUB-FORM-01 real-console-first-save` | 在同版本本地 Console 加载迁移后的两个实例 → 主区只有两项，七列真实 `<table>` 可增删改序，首次渲染高级正文不可见；展开、改值、再折叠保存，重开仍正确；切换模型 provider、修改一个高级叶不丢另一个分支或旧密钥。不能仅断言 `meta.collapse === true`。 |

实施时同步 `src/plugin/README.md`、`tests/test-suite.md`、`.context/STATE.md`；如改变存储公共查询，再同步 `src/wiki/README.md`。发布按 `AGENTS.md §4`：`mise exec -- pnpm build`、`mise exec -- pnpm test` → `mise exec -- pnpm pack` 产物直装测试实例 → 验证配置编辑、停止/启动、无额外外发后再打 tag。本方案阶段没有运行这些步骤。
