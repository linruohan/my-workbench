# @wb/desktop

个人工作台的桌面端：React 19 + Vite 界面，Tauri 2 原生外壳。

## 运行

在仓库根执行：

```bash
npm run tauri:dev    # 原生窗口 + HMR（推荐）
npm run dev          # 仅 Vite，浏览器预览，无文件系统 / 终端 / 语音
npm run build        # 前端生产构建
```

环境要求见根 [`README.md`](../../README.md) 与 [`docs/dev.md`](../../docs/dev.md)。

## 目录

| 路径 | 职责 |
| --- | --- |
| `src/App.tsx` | 视图路由、快捷键、提醒轮询、仓储装配 |
| `src/shell/` | 侧栏、标题栏、命令面板、通知、弹层 |
| `src/tasks/` | 任务列表 / 看板 / 统计 / 计划 / 编辑器 |
| `src/notes/` | 知识库视图、编辑器、文件树、kb-api |
| `src/timed/` | 定时任务列表、编辑器、执行器 |
| `src/agent/` | Agent 回合循环、Provider、工具、技能 / 插件 / MCP、OCR |
| `src/voice/` | 语音采集、CapsLock PTT、本地转写 |
| `src/settings/` | 设置分组与各 Pane |
| `src/lib/` | 偏好、持久化、路径、主题、字体、剪贴板 |
| `src-tauri/src/` | 文件 / 模型 HTTP / 语音 / OCR / 终端 / 网页窗口 / 字体 |

## 约定

- 领域规则放 `@wb/domain`，界面不直接改快照。
- 存储键集中在 `src/lib/persistence.ts`、`prefs.ts`、`paths.ts`。
- Tauri 能力通过 `src-tauri/src/lib.rs` 注册；新增命令同步 `capabilities/`。
- 单文件保持聚焦，超过约 400 行优先拆分。

完整开发与发布约定见 [`docs/dev.md`](../../docs/dev.md)、[`docs/standards.md`](../../docs/standards.md)。
