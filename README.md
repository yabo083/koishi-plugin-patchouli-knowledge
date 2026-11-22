# Patchouli Knowledge（不动的大图书馆）

一个 Koishi 插件：等群里的讨论告一段落，再把大家的观点、共识和仍有争议的问题整理成可检索的本地 llmwiki 词条。

## 特性

- **按群识别讨论**：根据每个群平时的发言频率识别活跃时段，可以只监听指定群，不监听私聊。
- **保留不同观点**：词条把结论、分歧和原话分开记录，方便读者查看结论的依据。
- **手动记录**：遇到群会议或事先约好的讨论，管理员可以用指令指定何时开始、何时结束记录。
- **本地查阅**：可以用阅读面板按群或关键词搜索，也可以直接打开 Markdown 文件，对照来源记录核对原话。
- **跨天追踪主题**：把同一话题在不同日期的词条整理成时间轴，同时保留每篇来源词条。
- **选择模型**：复用 ChatLuna 已配置的模型和凭据，也可以不装 ChatLuna，改用自定义模型端点。

## 工作原理

插件先观察每个群平时有多活跃，发言明显变密时才开始收集这一轮讨论。
发言慢下来后，它会再等一段时间，而不是在有人刚说完一句时就抢先总结。
讨论平息且消息数足够，插件才把这一轮交给模型；零散闲聊可以不生成词条。
值得保留的内容会写入本地知识库并更新索引，默认不在群里发总结通知。

## 安装

需要 Koishi `^4.18.0`，以及能接收目标群消息的机器人适配器。

**使用控制台**：在插件市场搜索 `patchouli-knowledge`，选择 `koishi-plugin-patchouli-knowledge` 安装。
先在插件配置页选好要监听的群和模型，再启用插件。

**使用命令行**：在 Koishi 实例的项目目录安装依赖，然后按下一节修改 `koishi.yml`。

```bash
pnpm add koishi-plugin-patchouli-knowledge
```

如果准备使用下面的最小配置，请先在同一个 Koishi 实例中启用 ChatLuna，并选好一个可用的默认模型。

## 最小配置

这个例子只监听一个群，用 ChatLuna 的默认模型整理讨论，不需要再填模型密钥。
把 `123456789` 换成目标群的频道 ID，保留引号：`channels` 接受字符串，不是数字。

```yaml
plugins:
  patchouli-knowledge:
    channels:
      - '123456789'
    dispatcher:
      provider: chatluna
```

如果文件里已有 `plugins:`，只把 `patchouli-knowledge:` 和它下面的内容并入现有配置，不要再写一个 `plugins:`。
如果控制台已经创建了插件配置，请修改已有实例，不要再启用第二份。

### 哪些配置可以省略？

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 开启群聊监听。 |
| `channels` | `[]` | 空列表表示监听所有群，不是禁用监听。 |
| `adminUsers` | `[]` | 允许使用管理指令的用户 ID 列表；留空时无人可用。 |
| `dispatcher.provider` | `chatluna` | 使用 ChatLuna；不使用它时选 `custom`。 |
| `storage.wikiDir` | `data/llmwiki` | 知识库目录，相对于 Koishi 实例目录。 |

**换一个模型**：使用 ChatLuna 时，在插件配置页选择模型，或将 `dispatcher.chatlunaModel` 写成 `平台名/模型名`；省略时继承平台默认模型。

**不用 ChatLuna**：把 `dispatcher.provider` 设为 `custom`，按模型供应商提供的信息填写以下字段：

- `dispatcher.baseURL`：模型服务的 API 根地址。
- `dispatcher.apiKey`：该服务的密钥，不能用阅读面板的登录密钥代替。
- `dispatcher.customModel`：服务端识别的模型名，不要额外加 ChatLuna 的平台前缀。

### 第一次使用怎么看效果？

1. 在白名单群里正常聊天。默认按发言频率触发，不是凑够几条消息就立即生成词条。
2. 等讨论平息。自动记录默认至少需要 12 条消息，平息观察期默认是 300 秒。
3. 有新词条后，从知识库的 `index.md` 查看索引；启用 Koishi 网页服务后，也可以打开 `/patchouli` 阅读面板。

想使用面板时，可以在插件配置页设置专用密钥 `security.apiToken`，然后按页面提示登录。
面板的群聊筛选适合找某个群的讨论；记得原话但忘了标题时，可以用关键词搜索正文。

### 数据保存在哪里？

下列路径都相对于 `storage.wikiDir`：

| 路径 | 内容 |
| --- | --- |
| `index.md` | 已生成词条的索引和摘要。 |
| `wiki/debates/` | 可用普通文本编辑器打开的 Markdown 词条。 |
| `raw/sessions/` | 与词条对应的原始会话记录。 |
| `log.md` | 按时间追加的知识库写入记录。 |

本地存储不等于离线处理：整理讨论时，群消息会提交给你选择的模型。
启用前请告知群成员，并限制知识库目录和备份的访问权限，尤其不要公开原始会话。

## 指令

按机器人配置的 Koishi 指令前缀调用；表中只列指令名。

| 指令 | 谁能用 | 用途 |
| --- | --- | --- |
| `patchouli` | 所有用户 | 查看插件简介、阅读面板入口及指令提示。 |
| `patchouli.status` | 管理员 | 查看本群当前状态、发言速率和已缓冲的消息数。 |
| `patchouli.logon` | 管理员 | 立即开始记录本群接下来的讨论，不必等发言变密。 |
| `patchouli.logoff` | 管理员 | 结束手动记录，将讨论交给模型整理；不足 2 条则丢弃。 |

这里的管理员指列入 `adminUsers` 的用户，不是群聊平台上的管理员角色。
要试用手动记录，请在配置页添加自己的用户 ID，再到已监听的群里执行 `patchouli.logon`；讨论结束时执行 `patchouli.logoff`。

## 开发

在插件源码目录运行以下命令。项目使用 pnpm，CI 在 Node.js 22 和 24 上运行。

```bash
# 按锁文件安装开发依赖
pnpm install --frozen-lockfile

# 编译插件并同步控制台客户端资源
pnpm build

# 运行测试（先构建）
pnpm test

# 只做 TypeScript 类型检查，不输出文件
pnpm typecheck
```

## 许可证

[MIT](./LICENSE)
