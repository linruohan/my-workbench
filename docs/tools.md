# DSH 工具对照

对照 DeepSeek Harness（`@deepseek-ai/dsh-tool-*`）与本仓库 Agent 工具面。

- **对照源**：`…/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-*`
- **本仓库实现**：`packages/domain/src/agent-workspace-tools.ts`、`packages/domain/src/agent.ts`、`apps/desktop/src/agent/workspace-tools.ts`、`apps/desktop/src-tauri/src/agent_workspace.rs`
- **原则**：不 npm 依赖 DSH/Cordis；按契约重实现，并绑在工作区 `rootPath` 与现有权限门上
- **对齐版本**：`0.1.10`（2026-11-08）；新增 / 删除 / 改参数工具时必须同步更新本文件

## 图例

| 状态 | 含义 |
| --- | --- |
| ✅ 已接入 | 模型可调用的同名或等价工具已落地，核心行为可用 |
| 🟡 部分接入 | 有替代实现，但名称、能力边界或运行时语义与 DSH 不完全一致 |
| ❌ 未接入 | 尚未提供；表中写明原因 |
| ⚙️ 基础设施 | 不是面向模型的工具名，而是执行器 / 策略插件 |

## 总览

| DSH 包 | 模型工具名 | 状态 | 本仓库对应 |
| --- | --- | --- | --- |
| `dsh-tool-fs` | `read` / `write` / `edit` / `apply_patch` / `read_image` | ✅ | 同名；`read_image` 会话附件库 + 下一轮多模态挂载 |
| `dsh-tool-fs-search` | `glob` / `grep` | ✅ | 同名 |
| `dsh-tool-working-directory` | `working_directory` | ✅ | 同名 |
| `dsh-tool-bash` | `bash` | ✅ | 同名；另有跨平台 `shell` |
| `dsh-tool-bash-persistent` | `bash`（持久） | 🟡 | `terminal_*` + `shell=bash` |
| `dsh-tool-pwsh` | `pwsh` | ✅ | 同名 |
| `dsh-tool-pwsh-persistent` | `pwsh`（持久） | 🟡 | `terminal_*` + `shell=pwsh` |
| `dsh-tool-terminal` | `terminal_open/send/read/list/close/signal` | ✅ | 同名；后端 portable-pty / ConPTY |
| `dsh-tool-jobs` | `job_list` / `job_output` / `job_kill` | ✅ | 同名；shell 后台任务 + 完成通知（空闲唤醒 / 下一步注入） |
| `dsh-tool-web` | `web_search` / `web_fetch` | ✅ | 同名；DeepSeek API 优先，回退 DDG/HTTP |
| `dsh-tool-todo` | `todo_write` | ✅ | 同名 |
| `dsh-tool-ask-user` | `ask_user_question` | ✅ | 同名；支持 `mode=timed` 倒计时后继续 |
| `dsh-tool-skill` | `skill` | 🟡 | `skill_list` / `skill_load` + `/name` |
| `dsh-tool-subagent` | 委派启动工具 | 🟡 | 默认托管 activation（立即返回 agentId）；`wait=true` 可同步 |
| `dsh-tool-subagent-control` | `list_agents` / `send_message` / `interrupt_agent` | 🟡 | 进程内注册表；父→子消息与中断；无冷恢复/外部后端 |
| `dsh-tool-str-replace-editor` | `str_replace_editor` | ✅ | 同名（`view`/`create`/`str_replace`/`insert`） |
| `dsh-tool-present` | `present` | ✅ | 同名；系统默认应用打开 + 可选资源管理器选中 |
| — | `office_to_pdf` | ✅ | DSH `@deepseek-ai/libreoffice-kit` Node/C++ 桥接（非 Rust 重实现） |
| `dsh-tool-goal` | `get_goal` / `create_goal` / `update_goal` | 🟡 | 同名轻量会话 goal；回合计数 + 空闲续行；`/goal` 人机面 |
| `dsh-tool-schedule` | `schedule_create/list/view/edit` | 🟡 | 映射 TimedTask + RRULE 子集；到期投递到目标会话 |
| `dsh-tool-session-query` | `session_search` / `session_trace` / `session_event_*` | 🟡 | 消息即事件；search/read/trace 已接，无 DSH 事件溯源存储 |
| `dsh-tool-workflow` | `workflow`（可改名） | ❌ | 无 PTC/多 subagent 编排运行时 |
| `dsh-tool-ralph` | `ralph` | ❌ | 实验性；依赖全新子 agent 序列 |
| `dsh-tool-cordis` | `cordis_inspect_list` / `cordis_inspect_query` | ❌ | 无 Cordis Host/Client |
| `dsh-tool-workspace-dependencies` | `load_workspace_dependencies` | 🟡 | 宿主 PATH 探测 node/python/pnpm；非 DSH 随包 runtime payload |
| `dsh-tool-call-timeout-policy` | （策略） | ⚙️🟡 | 分派层预算 + AbortSignal；shell `job_kill`；office 协作取消；超时 `TOOL_TIMEOUT` |
| `dsh-tool-executor-native` | （执行器） | ⚙️✅ | `turn.ts` 原生 function-call 分派 |
| `dsh-tool-executor-ptc` | `run_code` | ⚙️❌ | 无 PTC 运行时 / 生成 SDK |

---

## 逐包说明

### `dsh-tool-fs` — ✅ 已接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `read` | ✅ `read` | 行号窗口、路径 jail、相对 cwd |
| `write` | ✅ `write` | 工作区内写文件 |
| `edit` | ✅ `edit` | 字面量替换 |
| `apply_patch` | ✅ `apply_patch` | Codex 风格补丁（domain `agent-patch`） |
| `read_image` | ✅ `read_image` | PNG/JPEG/WebP/GIF 魔数校验；canvas 规范化（长边 ≤2048、JPEG 质量阶梯逼近 4 MiB）；会话附件库 + 下一轮 vision；超额挂载以 `<image_offload>` 提示可 `read_image` 重读 |

观察策略（轻量）：本会话须先 `read` / `read_image` / `view` 才可覆盖、编辑、删除已有文件；新建不存在路径仍允许；错误码 `FS_NOT_OBSERVED`。无版本新鲜度检测。

未对齐：沙箱围栏、稳定错误码体系（除观察策略）、内容寻址对象存储。

### `dsh-tool-fs-search` — ✅ 已接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `glob` | ✅ | 工作区文件发现，有结果上限 |
| `grep` | ✅ | 宿主 ripgrep；内联最多 250 条；超限写入 `.wb/spill`（捕获上限 2000） |

未对齐：部分 ignore/VCS 细节；glob 仍为自实现扫描（可选 rg）。

### `dsh-tool-working-directory` — ✅ 已接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `working_directory` | ✅ | 会话级 cwd；相对路径与 shell/文件工具跟随 |

未对齐：已打开的 PTY 进程不会随 cwd 切换自动 `cd`（与 DSH 文档一致：终端独立保留目录）。

### `dsh-tool-bash` — ✅ 已接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `bash` | ✅ `bash` | 强制 bash（Windows 需 Git Bash 等）；另有 `shell` 按平台默认 pwsh/bash |

环境：agent `bash`/`shell`/`pwsh` 与 `terminal_*` 启动时走 allowlist scrub（丢弃宿主机密与环境中的 `WB_*`），再按次注入受管事实：`WB_AGENT_SHELL=1`、`WB_HOME`、`WB_SESSION_ID`、`WB_WORKSPACE_ROOT`、`WB_CWD`（对齐 `dsh-shell-env` 的轻量版，无 contributor 注册表）。  

前台一律经 job 注册表等待：超时 **promoteOnTimeout**（不杀进程，返回同一 job id + 目前输出 + `[still running after …]`）；用户取消仍 `job_kill`。非零退出以 `[exit code: N]` 报告，工具本身仍成功。后台：`background: true` → `job_*`。  

模型侧渲染（对齐 `renderResult`）：无输出时 `(no output)`；stderr 以 `[stderr]` 分段；截断为 `[output truncated; full output: …]`；结构化结果含启动 `cwd`。工作区提示词要求检查 exit code。  

未对齐：插件式 `DSH_*` contributor 注册表、沙箱 `sandbox_permissions` / justification 升权。

### `dsh-tool-bash-persistent` — 🟡 部分接入

DSH 用按所有者隔离的持久 bash（跨调用保留 cwd/变量）。

本仓库不提供第二套名为 `bash` 的持久工具，而是：

- `terminal_open`（`shell=bash`）+ `terminal_send/read/...`

原因：避免与一次性 `shell`/`pwsh` 工具名冲突；统一走 PTY 会话更清晰。

### `dsh-tool-pwsh` — ✅ 已接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `pwsh` | ✅ | Windows PowerShell / pwsh；支持 `background` → job |

未对齐：完整 Windows 沙箱语言模式 / 命名管道约束、`DSH_*` 环境。

### `dsh-tool-pwsh-persistent` — 🟡 部分接入

同 bash-persistent：由 `terminal_*`（默认 Windows=`pwsh`）承担，不另注册持久 `pwsh` 工具名。

### `dsh-tool-terminal` — ✅ 已接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `terminal_open` | ✅ | portable-pty；Windows ConPTY |
| `terminal_send` | ✅ | Enter 发 `\r`；UI 也可输入 |
| `terminal_read` | ✅ | 滚动缓冲；返回前 strip ANSI |
| `terminal_list` | ✅ | |
| `terminal_close` | ✅ | |
| `terminal_signal` | ✅ | SIGINT→Ctrl+C；SIGTERM/KILL 杀进程 |

环境：同 shell，PTY 启动时 allowlist scrub。  

未对齐：完整 xterm.js 渲染、OSC 颜色恢复、Tab 补全菜单、Host 重启后进程恢复、DSH 侧栏配额语义。本仓库有轻量终端面板（文本预览 + 输入）。

### `dsh-tool-jobs` — ✅ 已接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `job_list` | ✅ | |
| `job_output` | ✅ | 支持 `wait` / `timeout`；读取会撤回待投递完成通知 |
| `job_kill` | ✅ | |
| 完成通知 | ✅ | 空闲会话自动唤醒；繁忙会话在下一步模型请求前注入 system 通知 |

未对齐：PTY/subagent 作为 job kind、steer 打断 wait、`kind` 字段细分。本仓库 job 来自 `background: true` 与前台超时 promote。

### `dsh-tool-web` — ✅ 已接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `web_search` | ✅ | 有 DeepSeek API Key → `/v1/tools/search`；否则 DuckDuckGo HTML |
| `web_fetch` | ✅ | 有 Key → `/v1/tools/fetch`；失败回退 HTTP+HTML 转文本 |

未对齐：DSH 的 search/fetch provider 注册表、凭据 ready 时动态撤下工具 schema、账号 `x-dsh-auth-token` 路由。

### `dsh-tool-todo` — ✅ 已接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `todo_write` | ✅ | 会话内完整待办覆盖写入 |

### `dsh-tool-ask-user` — ✅ 已接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `ask_user_question` | ✅ | 审批区选项/填空；`mode=timed` 倒计时到期后自动继续（`timeout: -1` 表示不限时） |

未对齐：子 agent 禁用规则的完整 DSH 语义、到期后问题仍可答的非阻塞 pending 返回。

### `dsh-tool-skill` — 🟡 部分接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `skill` | 🟡 | `skill_list`、`skill_load`；用户 `/名称` 点名 |

未对齐：DSH 单一 `skill` 工具 + 自动持久目录替换、发现不完整警告协议的完整形状。

### `dsh-tool-subagent` — 🟡 部分接入

| DSH 能力 | 本仓库 | 说明 |
| --- | --- | --- |
| 列出可用子智能体 | ✅ `subagent_list` | preset 列表 |
| 托管 activation | ✅ `subagent` | 默认立即返回 `agentId`；完成后系统通知唤醒父会话 |
| 同步委派 | ✅ `wait=true` | 等待最终文字；结束后销毁临时会话 |
| 深度限制 | ✅ | ≤ 2 |

未对齐：外部后端（ACP/Codex 等）、子级 preset/model 选择字段、冷恢复。

### `dsh-tool-subagent-control` — 🟡 部分接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `list_agents` | ✅ | `children` / `descendants`；进程内注册表 |
| `send_message` | ✅ | 父→子；running 入 inbox，inactive 触发续跑 |
| `interrupt_agent` | ✅ | 中断直接子级当前轮次 |

未对齐：子→父消息、跨进程/外部 agent、目录冷恢复。

### `dsh-tool-str-replace-editor` — ✅ 已接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `str_replace_editor` | ✅ | `view` / `create` / `str_replace` / `insert`；与 `read`/`write`/`edit` 并存以兼容 Claude Code 风格提示 |

`view`：文件超长按 `maxOutputChars=16000` 截断并附 `<response clipped>`；目录列出两级（跳过隐藏 / `node_modules` / `__pycache__`）。

### `dsh-tool-present` — ✅ 已接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `present` | ✅ | 工作区内普通文件：系统默认应用打开；`reveal` 默认同时在资源管理器选中 |

未对齐：DSH Session 交付物投影事件（`deliverables/presented`）、跨 cwd 绝对路径记账。

### `office_to_pdf`（DSH LibreOffice Kit）— ✅ 已接入

Rust 无法直接嵌入 LibreOffice Kit，因此通过 Node 桥接调用 `@deepseek-ai/libreoffice-kit`（原生 C++ helper）：

- 脚本：`apps/desktop/scripts/office-to-pdf.mjs`
- 命令：`agent_office_to_pdf`（路径 jail 在工作区内）
- 解析顺序：`WB_LIBREOFFICE_KIT` → 本地 `node_modules` → 本机 DSH 全局安装下的 kit

硬杀：前端 `opId` + `agent_office_cancel`；Rust 侧 Windows Job Object / Unix 进程组终止 Node 桥与子树（LibreOffice 引擎若未进同一 Job 仍可能残留，见已知限制）。

未对齐：字体元数据缓存调优、`renderImages` / `recalculate`、WASM 回退。

### `dsh-tool-goal` — 🟡 部分接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `get_goal` | ✅ | 每会话一个 goal |
| `create_goal` | ✅ | 精确 objective / max_goal_rounds |
| `update_goal` | ✅ | edit / pause / resume / complete / blocked + revision；模型不可 resume paused（`GOAL_TOOL_RESUME_PAUSED`） |
| Round 计数 | 🟡 | 顶层模型回合完成时 `roundsStarted++`；达 `maxRounds` → blocked |
| 续行驱动 | 🟡 | 会话空闲且队列为空时，若 active+armed 则注入 Goal Round 提示并再跑一轮；自主 complete/blocked 才注入 wrapup |
| blocked 阈值 | ✅ | 自主 Goal Round：`roundsStarted < blockedAfterConsecutiveRounds`（默认 3）时拒绝，`GOAL_TOOL_BLOCK_THRESHOLD`；用户直接回合可立即 blocked；策略提示与阈值同值 |
| `/goal` | ✅ | status / create / edit / pause / resume / clear；不进模型；resume paused 走用户路径 |

未对齐：跨会话持久 Goal 服务 / 事件溯源、`/goal` 附件随目标提交。

### `dsh-tool-schedule` — 🟡 部分接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `schedule_create` | ✅ | 写入 TimedTask；`rrule` 解析 FREQ/INTERVAL/BYDAY/UNTIL 子集 |
| `schedule_list` / `schedule_view` | ✅ | |
| `schedule_edit` | ✅ | update/delete + `expectedUpdatedAt` 乐观锁 |
| 到期投递 | 🟡 | 通知 + 将 prompt 投递到 `this_session` / `new_once` / `new` 目标会话 |

未对齐：DSH Host `ctx.schedule` 完整 RRULE、投递与 Session 恢复语义的全部细节。

### `dsh-tool-session-query` — 🟡 部分接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `session_search` | ✅ | 同工作区其他会话消息全文检索 |
| `session_trace` | ✅ | 指定/当前会话近期事件摘要 |
| `session_event_search` | ✅ | 单会话消息事件搜索；当前会话默认截断到最近 user 之前 |
| `session_event_read` | ✅ | 按 1-based `seq` 读完整消息 + 可选邻居 |
| `session_event_trace` | ✅ | 前后邻居 + 同 `toolCallId` / 批工具结果关联 |

未对齐：DSH 事件溯源存储、surface（current/shadowed）、替换链、跨进程事件投影。

### `dsh-tool-workflow` — ❌ 未接入

| DSH 工具 | 原因 |
| --- | --- |
| `workflow`（可配置名） | 需要 JS 编排运行时 + 多 subagent 委派；依赖 PTC/subagent 栈，超出当前范围 |

### `dsh-tool-ralph` — ❌ 未接入

| DSH 工具 | 原因 |
| --- | --- |
| `ralph` | 实验性；多 Round 全新子 agent + 有界报告。依赖 subagent/goal 能力，未规划 |

### `dsh-tool-cordis` — ❌ 未接入

| DSH 工具 | 原因 |
| --- | --- |
| `cordis_inspect_list` / `cordis_inspect_query` | 面向 Cordis 插件运行时自省。本仓库不嵌入 Cordis Host/Client |

### `dsh-tool-workspace-dependencies` — 🟡 部分接入

| DSH 工具 | 本仓库 | 说明 |
| --- | --- | --- |
| `load_workspace_dependencies` | 🟡 | `agent_workspace_runtime_paths` 探测 PATH 上的 node/python/pnpm |

未对齐：DSH `runtime.json` / `dependencies/` 随包 payload、Harness home 安装复制、Office skill 绑定解释器。

### `dsh-tool-call-timeout-policy` — ⚙️🟡 基础设施

DSH：统一协作式取消 + 超时错误映射。

本仓库：`turn.ts` 对 web/shell/office/subagent/job_output 等声明默认预算；工具执行与 drain 循环协作监听 `AbortSignal`；超时 `TOOL_TIMEOUT`。前台 shell 经 job + `job_kill`（Job Object / 进程组）硬停；`office_to_pdf` 超时/中止调用 `agent_office_cancel` 硬杀桥接进程树；`web_*` 仍为竞赛取消 HTTP。

### 进程树硬杀（对齐 `dsh-win32-process` 语义，本地重写）— ⚙️✅

- Windows：unnamed Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；`job_kill` / shell 超时 / office cancel 走 `TerminateJobObject`
- Unix：`process_group(0)` + `kill(-pgid, SIGKILL)`
- 覆盖：`agent_workspace_shell`、后台/可取消 job、`agent_office_to_pdf`

### Spill / output retention（对齐 `dsh-spill*` + `dsh-output-retention`，本地重写）— ⚙️🟡

- 超限 shell/job 输出 tee 到工作区 `.wb/spill/*.txt`，内联保留 head/tail 预览 + 恢复提示（可用 `read`/`grep`）
- `web_fetch` 超 `WEB_FETCH_LIMIT` 时同样落盘 spill（需已绑定工作区）
- Domain：`output-retention.ts`；Desktop：`spill-store.ts`

- 启动 GC：绑定工作区时清理 `.wb/spill` 中超过 30 天的文件（`cleanupToolSpill`）
- 模型视图：`pruneOversizedToolResults` 对超长工具结果做 head/tail 修剪，再必要时 microcompact 硬清

- `grep`：捕获超过内联上限（或触达捕获上限）时，匹配全文 tee 到 `.wb/spill`，模型侧附 `retentionNotice`
- 图片（轻量）：单轮 vision 挂载有张数 / 体积上限；超出的较早附件仍留在会话附件库，并向模型注入 `<image_offload>` 路径提示（可 `read_image` 重读）

未对齐：token 级 spill-policy（文字+图片共享估算预算）、完整 provider `IMAGE_OFFLOAD_REQUIRED` 拒图重试协议。

### `dsh-repeat-tool-reminder` — ⚙️✅ 基础设施

- 精确匹配同工具 + 规范化参数连续链；阈值 3 / 5 / 8；仅建议、不阻断
- 新用户消息清零；`todo_write` / `job_output` 透明排除
- Domain：`agent-repeat-tool.ts`；接线 `turn.ts` `sayTool` 之后

### `dsh-permission-presets` — ⚙️🟡 别名映射（无沙箱）

本仓库仍是三档：`confirm` / `session_auto` / `readonly`。  
别名：`default`/`ask`→confirm，`auto`→session_auto，`readonly`→readonly；`/permission` 同 `/mode`。  
不引入 `workspace-write` / `danger-full-access`（依赖 Windows ACL 沙箱，整包延后）。

### `dsh-tool-executor-native` — ⚙️✅ 基础设施

本仓库 `apps/desktop/src/agent/turn.ts` 走原生 tool call 分派（非 PTC）。

### `dsh-tool-executor-ptc` — ⚙️❌ 基础设施

| 能力 | 原因 |
| --- | --- |
| `run_code` + 生成 SDK | 无 `ptcRuntime`；不引入程序化工具执行模式 |

---

## 本仓库额外工具（非 DSH `dsh-tool-*`）

工作台产品工具仍在 `AGENT_TOOLS` 中，例如：

- 任务 / 项目 / 标签 / 计时：`task_*`、`project_*`、`tag_*`、`timer_*`
- 笔记 / 搜索 / 通知 / UI：`note_*`、`search`、`notification_*`、`ui_open`
- 设置 / 记忆 / MCP / 插件 / 本机工具：`settings_*`、`memory_*`、`mcp_list`、`plugin_list`、`host_tool_*`

这些不属于 DSH `dsh-tool-*` 对照范围，但与 Agent 共用同一套权限与回合管线。

另：`shell` 是本仓库的跨平台入口（对齐 DSH `dsh-shell` 抽象 + bash/pwsh 二选一），DSH 目录里没有名为 `dsh-tool-shell` 的包。

---

## 接入优先级备忘（若继续对齐）

1. **高价值、可渐进**：沙箱（Windows ACL，整包延后）  
2. **明确不做 / 低优先**：Cordis 自省、PTC `run_code`、Ralph、workflow 全编排  
3. **DSH 产品对齐**：工具面 / shell 卫生 / str_replace view / goal blocked 阈值 / 图片 offload 提示已过拐点；再借包清单收益偏低

---

## 维护说明

更新本文件时：

1. 以本机 DSH 安装目录下的 `dsh-tool-*` 包名为准  
2. 对照 `HOST_AGENT_TOOL_NAMES` / `AGENT_TOOLS`  
3. 「部分接入」必须写清**差在哪**，避免把替代实现标成完全对齐  
