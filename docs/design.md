# 个人工作台 · 设计与实现

状态：与代码 `0.1.10` 对齐  
日期：2026-11-08  
范围：单人使用、Windows 优先的桌面应用；**所有业务数据仅保存在本机**

本文同时记录产品意图与当前落地方式。标注「已实现」的部分以代码为准；标注「未落地」的部分保留为后续方向，不应被理解为现有能力。

## 1. 定位

日常工作分散在任务应用、笔记应用和模型客户端里，任务、笔记与对话不共享对象。本应用把这几件事收进一个本地库与一套界面语言：

- 任务采用 Super Productivity 的计划日 / 时刻 / 截止模型；
- 知识库直接用用户自己的本机文件夹，Markdown 保持纯文本；
- Agent 以工作区文件夹为中心，经统一工具面管理任务、笔记与文件；
- 定时任务把「一句话指令 + 重复节奏」投递回 Agent 会话；
- 提醒、通知、主题、字体与模型配置都留在本机。

数据本地保存是硬性要求：不设云端账号，不把业务库上传到任何服务器。断网时除「请求外部模型 / 首次下载模型」外，主要能力完整可用。

## 2. 已实现能力

| 能力 | 用户感知 | 边界 |
| --- | --- | --- |
| **任务** | 今日、收件箱、已完成、计划、项目、子任务、标签、计时、重复、提醒 | 不承载长文知识 |
| **计划** | 按日期时间线汇总全部已排期任务 | 独立时间表 / 日历块视图未落地 |
| **定时任务** | 每小时 / 每天 / 工作日 / 每周 / 每月 / 自定义；投递指令或技能到 Agent | 依赖应用在前台或刚启动后的轮询 |
| **知识库** | 本机目录建库；文件树、实时编辑、预览、搜索、快速打开、查找替换 | FTS5 / 双向链接 / 嵌入检索未落地 |
| **Agent** | 工作区、会话、审批、模型、工具、终端、子智能体、插件、MCP | 不直连仓储；写操作过领域函数 |
| **提醒 / 通知** | 计划与截止提醒、应用内通知中心、冷却与稍后提醒 | 系统通知开关尚未接线 |
| **外观** | 浅色 / 深色主题、系统字体扫描、界面字体与网页字体 | 跟随系统主题未落地 |

设置分组：基础设置（常规、外观、通知、语音输入）、Agent（模型、个性化、记忆、子智能体、插件、MCP 服务器、技能、命令、钩子、工具）、数据与关于。

## 3. 信息架构

侧栏按「任务 / 知识库 / Agent」组织；设置与通知不占常驻第三栏。

```
工作台
├── 任务
│   ├── 今日 / 收件箱 / 已完成
│   ├── 计划
│   ├── 定时任务
│   └── 项目（收件箱 + 自建项目）
├── 知识库
├── Agent
│   └── 工作区 → 会话（置顶 / 归档 / 网页会话）
└── 底栏：本地账号 · 设置
```

任务视图内再切换列表 / 看板 / 统计。命令面板（`Ctrl+P` 或 `Ctrl+K`）跨任务、Agent 会话、笔记、知识库文件、页面与项目检索，不占侧栏项。

## 4. 交互

### 4.1 快捷键

| 键 | 作用 |
| --- | --- |
| `Ctrl+P` / `Ctrl+K` | 打开全局命令面板 |
| `Ctrl+N` | 聚焦当前视图的快速输入 |
| `Ctrl+N`（设置内） | 不拦截 |
| `Esc` | 关闭命令面板 / 菜单 / 弹层 |

Agent 输入框内以 `/` 开头触发斜杠命令；CapsLock 按住说话由语音设置控制。

### 4.2 快速捕获

在今日、收件箱、计划、项目或定时任务视图中输入一句话，提交前解析：

| 片段 | 写入 |
| --- | --- |
| 今天 / 明天 / 周五 / 下周X / M月D日 | `dueDay`，并清空 `dueWithTime` |
| 上午 / 下午 / HH:mm | `dueWithTime`，并清空 `dueDay` |
| `提前N分钟` | 仅在同时解析出计划时刻时写 `remindAt`；仅支持 5 / 10 / 15 / 30 / 60 分钟 |
| `截止今天/明天/周五/下周X/M月D日` | `deadlineDay`（快速捕获不解析截止时刻） |
| `#项目名` | 匹配已有项目；不存在时自动创建 |
| 无日期 | 收件箱项目，两个计划字段都空 |

### 4.3 完成、重复与计时

- 完成时写 `doneOn`，并清除未触发的提醒。
- 重复不是独立配置表：`repeatCfgId` 字段直接存 `TimedSchedule` 的 JSON，可复用与定时任务相同的节奏模型与展示文案。只有主任务可重复。
- 当前只有一个计时任务；切换计时先把上一段结算到原任务，按本地日期累加到 `timeSpentOnDay`，`timeSpent` 为各日之和。
- 有子任务的父任务展示子任务汇总，不单独计时。

### 4.4 提醒与通知

提醒偏移：不提醒 / 到点 / 提前 5·10·15·30 分钟 / 提前 1 小时。

- 计划提醒挂在 `remindAt`，截止提醒独立存 `deadlineRemindAt`。
- 宿主每 15 秒扫描到期提醒与定时任务；到期后写通知、弹出提醒卡并打开通知中心。
- 同一次提醒被忽略后进入约 5 分钟冷却，不反复抢焦点。
- 通知来源包括任务提醒、截止提醒、定时任务与 Agent 系统消息。
- `systemNotifications` 偏好已存在，但尚未调用系统通知 API（未落地）。

## 5. 数据模型与持久化

### 5.1 运行时存储

界面使用 `@wb/db/memory` 的 `MemoryWorkbenchRepository`：内存映射 + JSON 快照。Tauri 下写入 `%APPDATA%\my-workbench\workbench.json`，同时保留 `localStorage` 备份；浏览器预览只写 `wb.local.v1`。

快照键：

| 键 | 内容 |
| --- | --- |
| `tasks` / `projects` / `buckets` | 任务、项目、项目桶（`active` / `backlog`） |
| `todayOrder` | 今日手排顺序 |
| `tags` / `taskTags` | 标签与任务标签关系 |
| `notes` | 应用内笔记（`bodyMd`） |
| `notifications` | 通知中心记录 |
| `timedTasks` | 定时任务与下次运行时刻 |
| `agentWorkspaces` / `agentThreads` | Agent 工作区与会话 |
| `agentMessages` / `agentApprovals` | Agent 消息与审批记录 |

`packages/db` 仍保留 SQLite 仓储用于实验与测试，但**当前桌面运行时未接入**。设计文档不再假设生产库是 `workbench.db`。

### 5.2 任务

`Task` 关键字段：`projectId`、`parentId`、`title`、`notes`、`isDone` / `doneOn`、`dueDay` / `dueWithTime`、`deadlineDay` / `deadlineWithTime`、`remindAt` / `deadlineRemindAt`、`timeEstimate`、`timeSpent` / `timeSpentOnDay`、`repeatCfgId`。

不变量放在 `@wb/domain`：

- 设置 `dueWithTime` 时清空 `dueDay`，反之亦然；读取时时刻优先。
- 截止字段同理。
- 子任务不能写 `repeatCfgId`。
- 完成时清空提醒。
- 今日成员只看未完成且计划日 ≤ 今天，父任务已在今日时子任务不重复占行。

### 5.3 知识库

知识库正文不进入工作台快照，而是直接读写用户选择的本地目录：

- 支持的扩展：Markdown、常见图片、以及代码 / 配置 / 文本类文件（`kb.ts` 白名单）。
- 多个库根目录与最近使用记录保存在 WebView `localStorage`，不是业务快照。
- 应用内 `notes` 仍可存在，用于「最近笔记」等轻量记录。

### 5.4 配置与密钥

| 内容 | 位置 |
| --- | --- |
| 常规设置、Agent 个性化、记忆、钩子、子智能体、命令、MCP、技能开关、插件目录 | `prefs.json` |
| 主题 | `theme.json` |
| Provider 列表与默认模型 | `wb.providers.v1`（localStorage） |
| API Key | `wb.credentials.v1`（localStorage，仅随请求发送给对应 Provider） |
| 本地模型 | `%APPDATA%\my-workbench\models\*` |
| Agent 超长输出 | 工作区 `.wb\spill\*`（30 天启动清理） |

## 6. 系统架构

```
React Renderer（apps/desktop/src）
├── 任务 / 计划 / 知识库 / 定时 / 通知 / 设置界面
├── Agent 回合循环、工具分派、审批、子智能体、插件与 MCP
├── 语音采集与本地 OCR（onnxruntime-web）
└── MemoryWorkbenchRepository（JSON 快照）
        │ Tauri invoke / plugin-fs
Tauri Rust Host（apps/desktop/src-tauri/src）
├── kb：目录选择、文件读写、base64、重命名、Git 分支、资源管理器
├── model_http / oc_runtime：模型请求与本机 OpenCode
├── speech：本地 ASR 模型准备、热备、转写、下载进度
├── ocr：PaddleOCR 模型下载与读取
├── agent_workspace：shell / job / PTY 终端 / Office 转 PDF / runtime 探测
├── fonts：系统字体扫描
└── web_session：内嵌网页窗口的显示、刷新、隐藏、关闭
```

与早期设想的差异：

- Agent 运行时在 Renderer 内，而不是独立 sidecar 子进程；模型请求经 Rust `model_http` 发起，便于代理与超时控制。
- 没有「宿主持有数据库、Agent 不直连」的物理隔离；隔离靠领域函数、权限门与工具契约，而不是进程边界。
- 提醒扫描在界面层 15 秒轮询，不是 Rust 后台调度器；应用未运行时不会触发。
- 知识库不落 SQLite FTS 索引，检索以文件名 / 内容扫描与命令面板为主。

## 7. Agent 设计

### 7.1 工作区与会话

- `AgentWorkspace`：`title`、`rootPath`（本机绝对路径，可为空）、时间戳；内置「默认工作区」。
- `AgentThread`：`workspaceId`、`projectId`、`title`、`modelRef`、`permissionMode`、`queueJson`、`webUrl`、`archivedAt`、`pinnedAt`。
- 会话可按工作区归档 / 置顶；`webUrl` 非空即「网页会话」，可在独立窗口显示页面。
- 会话与消息、审批一并进入 `workbench.json` 快照。

### 7.2 Provider 与模型

`ProviderKind`：`builtin`、`openai-chat-completions`、`openai-responses`、`anthropic-messages`。

- 模板：Ollama（本机）、OpenAI、DeepSeek、智谱、Anthropic、自定义端点。
- 支持拉取模型列表、单模型连通性测试、`model_ref` 形如 `providerId/modelId`。
- 内置免费通道：DSH Free 目录同步与 OpenCode 本地免费模型；后者在 Tauri 下调用 `oc_complete`。
- HTTP 代理在常规设置中配置，只影响模型请求，不读取系统环境变量。
- 密钥不出现在工具参数与会话快照中。

### 7.3 工具面

内置工作台工具覆盖：`task_*`、`project_*`、`tag_*`、`timer_*`、`note_*`、`search`、`notification_*`、`ui_open`、`settings_*`、`memory_*`、`plugin_list`、`mcp_list`、`host_tool_*`、`subagent*`、`list_agents` / `send_message` / `interrupt_agent`、`goal_*`、`schedule_*`、`session_*`。

工作区工具覆盖：`read` / `read_image` / `write` / `edit` / `apply_patch` / `str_replace_editor`、`glob` / `grep`、`bash` / `pwsh` / `shell` / `working_directory`、`terminal_*`、`job_*`、`web_search` / `web_fetch`、`todo_write`、`ask_user_question`、`skill_list` / `skill_load`、`present`、`office_to_pdf`、`load_workspace_dependencies`。

逐项与 DSH 的对照、差异与未接入项见 [`tools.md`](tools.md)；新增工具必须同时更新该文件。

### 7.4 权限与审批

| 模式 | 语义 |
| --- | --- |
| `confirm`（默认，别名 `default` / `ask`） | 写工具执行前弹审批卡 |
| `session_auto`（别名 `auto`） | 本会话非破坏性写自动批准；破坏性操作仍确认 |
| `readonly` | 只注册读工具，写工具直接阻止 |

`gateTool` 统一判定 `run` / `ask` / `block`。审批卡展示工具名、摘要与参数，结果写 `agentApprovals`。

### 7.5 扩展管理

| 组件 | 管理方式 | 存储 |
| --- | --- | --- |
| 个性化 | 写给 Agent 的长期偏好 | `prefs.json` |
| 记忆 | 手动增删的短事实，可被 `/memory` 读写 | `prefs.json` |
| 子智能体 | 名称、描述、system prompt、工具子集 | `prefs.json` |
| 技能 | 本地目录扫描 + 插件内技能；可启停 | `prefs.json` 记录目录与禁用项 |
| 斜杠命令 | 内置命令 + 自定义命令 | 内置在 domain，自定义在 `prefs.json` |
| 钩子 | 任务完成 / 提醒触发 / 会话开始 | `prefs.json` |
| MCP 服务器 | 本地或 HTTP 端点，可启停 | `prefs.json` |
| 插件 | 选择本地插件目录，加载技能 / 命令 / 子智能体 / 钩子 / MCP | 目录内清单 + `prefs.json` 启用状态 |

### 7.6 输入与运行体验

- 图片附件按会话保存；支持多模态挂载，超出上限的旧图仍可 `read_image` 重读。
- 纯文本模型通道（如本机 OpenCode）在需要看图时回退到本地 PaddleOCR 识图。
- 语音输入：SenseVoiceSmall (INT8)、Fun-ASR-Nano-GGUF、QwenCTC；模型在数据目录 `models/<engine>`，首次使用在设置中下载；CapsLock 按住说话，释放后写回当前输入框，焦点不在可编辑区时走剪贴板粘贴。
- 输入历史、斜杠建议、上下文用量圆环、消息队列、终端面板与工作区 rail 都在 Agent 视图内。

## 8. 定时任务

`TimedTask`：`title`、`command`、`schedule`、`enabled`、`lastRunAt`、`nextRunAt`。

- 预设：每小时、每天、工作日、每周、每月；自定义支持 `every + unit`（分 / 时 / 日 / 周 / 月 / 年）、执行时刻与结束日期。
- `schedule_*` Agent 工具与界面共用同一模型，接受 RRULE 子集（FREQ / INTERVAL / BYDAY / UNTIL）。
- 到期后：写系统通知 → 构建提示词 → 复用或新建 Agent 会话（绑定工作区与技能）→ 投递执行。
- 应用关闭期间错过的触发不会自动补跑，面板提供「立即执行」；「跳过本次」只标记已运行，不创建会话。

## 9. 知识库

- 根目录：用户可添加多个本机文件夹，记录当前库、最近库与排序偏好（localStorage）。
- 文件树：在当前目录新建 Markdown、重命名当前文件、移除库根、在资源管理器中显示；按名称过滤与排序。
- 编辑：Markdown 实时预览（Typora 风格）、源码、纯预览三种模式；块级交互与跨块选择；预览区粘贴图片导入到笔记资源目录。
- 查找替换、快速打开（`Ctrl+P`）、命令面板按文件名 / 路径检索、Git 分支显示。
- 自动保存：编辑后延迟写盘，失败保留 dirty / error 状态；图片与二进制走 base64 读写。
- 非 Tauri 预览态只能查看，不能写本机文件。

## 10. 外观与性能

- 主题仅浅色 / 深色；`theme.json` 持久化；CSS 变量 `--wb-*` 统一令牌。
- 系统字体经 Rust `font-kit` 扫描，应用于界面字体与内嵌网页默认字体；搜索支持中文名与文件名别名。
- Agent 消息与 Markdown 实时预览使用窗口化渲染；长列表按需渲染。
- 动画短、可关；`prefers-reduced-motion` 归零。
- 性能预算沿用：视图切换首帧 ≤ 100ms、命令面板 ≤ 80ms、完成 / 排期乐观更新 ≤ 50ms；以本地实测为准。

## 11. 已落地与未落地

已落地：任务全主路径、看板与统计、计划时间线、重复、计时、提醒与通知中心、定时任务、知识库本机目录与三态编辑、Agent 会话与工作区、模型 Provider、免费模型通道、工具面、权限审批、技能 / 记忆 / 钩子 / 命令 / 子智能体 / 插件 / MCP、终端与后台任务、网页会话、图片附件与 OCR、语音输入、系统字体、浅深主题。

未落地：独立时间表 / 日历视图、标签导航页、计划视图 15 列与工作日跳过、FTS5 全文索引、双向链接、嵌入检索、系统通知接线、托盘常驻、数据目录迁移与一键备份界面、SQLite 生产库、Windows ACL 沙箱、PTC `run_code`、workflow / ralph / Cordis、第二设备同步、插件远程市场。

## 12. 风险与约束

| 风险 | 处理 |
| --- | --- |
| 今日被做成标签或状态 | 领域层禁止 `TODAY` 标签；今日只看计划字段 |
| 计划日与时刻同时有值 | 写入时互斥；读取时时刻优先 |
| 提醒依赖应用进程 | 当前接受该边界；文档与验收不承诺退出后提醒 |
| 快照文件损坏 | 同时保留 localStorage 备份；复制数据目录可备份 |
| 密钥进入快照 / 日志 | Provider 密钥单独存 localStorage，按请求附加 |
| Agent 绕过领域不变量 | 工具只调领域函数与仓储方法，不直接改快照 |
| 工作区工具越界 | 路径 jail 在工作区 `rootPath`；shell / job 进程树硬杀 |
| 语音 / OCR 模型体积大 | 按需下载、显示进度、可取消；资源与运行时不随安装包膨胀 |
| 本地免费通道依赖第三方网关 | 失败时明确报错，不回退静默扣费 |
| 范围滑向云同步 / 多人协作 | 以本文第 1、2 节边界为准 |

## 13. 参考

- 任务模型与「今日」规则：Super Productivity（计划日 / 时刻互斥、收件箱、项目桶、工时按日）。
- Agent 宿主 / 工具 / 插件形态：ZCode（思想对齐，协议与实现自研）。
- 工具面细节：DeepSeek Harness `dsh-tool-*`，逐项见 [`tools.md`](tools.md)。
- 本地优先：Ink & Switch, *Local-first software*；本应用进一步收紧为「无云端业务库」。
- 桌面壳：Tauri 2；编辑器：markdown-it + highlight.js；本地推理：onnxruntime-web（OCR）与随包语音运行时。
