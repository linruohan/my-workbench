# 开发约定

## 1. 环境

- Windows 10/11（主平台）；Node.js ≥ 20；npm workspaces。
- Rust ≥ 1.90 + VS Build Tools（C++ 桌面开发）；WebView2。
- 本地语音 / OCR 首次使用需联网下载模型；开发时可不装，功能入口会提示未就绪。

```bash
npm install
npm run dev          # 仅 Vite，浏览器预览，无 Tauri 能力
npm run tauri:dev    # 推荐：原生窗口 + 前端 HMR
```

## 2. 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run check` | 发版门禁：Prettier 检查 → Oxlint → 四个包类型检查 → 全部测试 |
| `npm test` / `npm run test:domain` / `test:db` / `test:theme` | Vitest |
| `npm run typecheck` | 各包 `tsc --noEmit` |
| `npm run lint` / `npm run format` | 桌面端 Oxlint / Prettier 写入 |
| `npm run build` | 前端生产构建 |
| `npm run pack:win` | Tauri 打包（Windows） |
| `npm run pack:check` | `check` + 前端构建 |
| `npm run release:notes` | 由提交生成 Release Notes 草稿 |

单个包内可 `npm run test -w @wb/desktop -- <pattern>` 只跑匹配用例。

## 3. 目录职责

```
apps/desktop/src
├── App.tsx                 入口、视图路由、快捷键、提醒轮询、全局状态装配
├── shell/                  Sidebar / TitleBar / 命令面板 / 通知 / 弹层
├── tasks/                  任务列表、看板、统计、计划、编辑器、行组件
├── notes/                  知识库视图、编辑器、文件树、快速打开、查找替换、kb-api
├── timed/                  定时任务列表、编辑器、重复选择、执行器
├── agent/                  Agent 视图、回合循环、Provider、工具、技能/插件/MCP、OCR
├── voice/                  语音采集、PTT、本地转写
├── settings/               设置分组及各 Pane
├── ui/                     通用组件（字段、编辑器、拖拽、图标、确认框等）
└── lib/                    偏好、持久化、路径、主题、字体、剪贴板、事件等
```

- `packages/domain`：纯函数与类型，**不引入 React、DOM、Tauri、文件系统**。所有不变量（计划日 / 时刻互斥、今日、重复、统计、提醒、定时、Agent 契约、知识库扩展白名单）先落在这里。
- `packages/db`：`MemoryWorkbenchRepository` 与快照导入导出；SQLite 仓储仅实验，不接桌面运行时。
- `packages/theme`：令牌与主题解析，不依赖其他包。
- `apps/desktop/src-tauri`：只做原生能力与进程/窗口管理，不承载领域规则。

依赖方向：`apps/desktop → domain / db / theme`；`db → domain`；`domain`、`theme` 不反向依赖。

## 4. 改代码时的落点

| 需求 | 落点 |
| --- | --- |
| 新增任务字段 / 校验 | `packages/domain/src/task.ts`（及相邻领域文件）→ 快照归一化 → 编辑器 / 行 / 统计 |
| 新增视图 | `apps/desktop/src/<feature>/XxxView.tsx` + `App.tsx` 路由 + `shell/Sidebar.tsx` |
| 新增 Agent 工具 | `packages/domain` 工具契约 + `agent/host-tools.ts` 或 `agent/workspace-tools.ts` + 系统提示 + `docs/tools.md` |
| 新增定时预设 | `packages/domain/src/timed-task.ts` + `timed/ScheduleAddMenu.tsx` + 编辑器 |
| 新增知识库可打开类型 | `packages/domain/src/kb.ts` 白名单 + 文件树 / 编辑器分支 |
| 新增原生能力 | `src-tauri/src/<mod>.rs` + `lib.rs` 注册 + `capabilities/` 权限 + 前端封装 |
| 新增设置项 | `lib/prefs.ts` 默认值与归一化 + `settings/*Pane` |

## 5. 数据兼容

- 快照升级必须在仓储 `load` / 归一化处补默认值，不允许读旧 `workbench.json` 崩溃。
- 不把 Provider 密钥写进快照、日志或工具参数；密钥只走 `wb.credentials.v1`。
- 破坏性数据迁移要单独提交，并在 `release.md` 的升级说明中写清。
- 快照字段删除前先确认没有 UI、Agent 工具与统计在读。

## 6. 代码风格

- 界面文案中文；标识符、文件名、工具名英文。
- 单文件保持聚焦，超过约 400 行优先拆分（视图 / 面板 / 纯逻辑），避免功能耦合。
- 函数级中文注释说明「做什么、边界在哪」；显而易见的赋值不注释。
- 组件不直接拼存储键；存储键集中在 `lib/persistence.ts`、`lib/prefs.ts`、`lib/paths.ts`。
- 领域函数优先纯函数；时间计算显式传入「现在」，不在领域层取系统时间。
- 不用 `any` 逃避类型；跨包类型走 `packages/domain`。
- 新增依赖前说明用途与体积影响；原生依赖同步更新 Cargo 与 capabilities。

## 7. 测试

- 领域规则必须有 Vitest：互斥字段、今日、逾期、重复、提醒窗口、统计、定时下次运行、知识库路径与白名单、工具权限门。
- 仓储测试覆盖快照 round-trip 与旧数据归一化。
- 桌面端测试覆盖纯逻辑与工具分派；DOM 交互用轻量组件测试，不引入浏览器 E2E 作为门禁。
- 修复缺陷时先补一个能复现的用例，再改实现。

## 8. 文档同步

- 能力、入口、快捷键、数据位置变化：改 `README.md` 与 `docs/design.md`。
- 工具增删或参数变化：改 `docs/tools.md`，并在工具描述里写「何时用 / 何时不用」。
- 构建、资源、产物变化：改 `docs/packaging.md`。
- 版本与验收变化：改 `docs/release.md`，并在 `开发报告.md` 追加一条修订记录。
- 不新建零散说明文件；优先更新现有文档。

## 9. 调试提示

- 浏览器预览与桌面行为不同的地方，先看 `isTauri()` 分支与 `lib/paths.ts`。
- 原生窗口（网页会话、终端 PTY）问题看 `src-tauri` 日志；前端日志在 DevTools。
- 模型请求失败先看「设置 · 模型」的连通性测试与代理设置，再抓 `model_http` 返回。
- 语音 / OCR 未就绪时检查 `%APPDATA%\my-workbench\models\` 下的模型目录与下载状态。
- 提醒不触发先确认应用在运行、`remindAt` 是否已写、通知冷却是否生效。
