# 个人工作台 (my-workbench)

本地优先的桌面个人工作台（Tauri 2 + React）。主体能力：任务、日程、知识库、Agent、定时任务、提醒与通知。无云端账号，业务数据只落本机。

当前版本 `0.1.4`。

| 文档 | 说明 |
| --- | --- |
| [`docs/design.md`](docs/design.md) | 产品与架构设计 |
| [`docs/standards.md`](docs/standards.md) | 代码规范 |
| [`docs/release.md`](docs/release.md) | 发布标准 |
| [`docs/packaging.md`](docs/packaging.md) | 打包与发版操作 |
| [`docs/dev.md`](docs/dev.md) | 日常开发约定 |
| [`开发报告.md`](开发报告.md) | 完整开发日志 |

## 结构

```
apps/desktop     Tauri 2 + React 界面与原生能力
packages/domain  领域规则（任务 / 日程 / Agent / 知识库路径等）
packages/db      SQLite / 内存仓储
packages/theme   统一设计令牌与主题解析
```

## 能力概览

侧栏按「任务」分组导航，另有知识库与 Agent：

| 入口 | 说明 |
| --- | --- |
| 今日 / 收件箱 / 已完成 | 今日由计划日计算；无日期任务进收件箱；已完成单独视图 |
| 计划 | 按日排期；有具体时刻的任务也汇总在此 |
| 项目 | 收件箱与自定义项目；`Ctrl+N` 快速捕获 |
| 定时任务 | 按计划自动执行的指令（每天 / 每周等） |
| 知识库 | 选择本机目录作库；Markdown / 文本 / 图片；块级实时编辑 |
| Agent | 按工作区文件夹建会话；本机理解常用指令，可接外部模型；写操作默认需批准 |
| 通知 / 主题 | 标题栏通知中心；主题在跟随系统 / 浅色 / 深色间切换 |

设置含：常规、外观、通知、模型（Provider）、数据目录、关于。

## 开发

```bash
npm install
npm run check        # 格式 + lint + 类型 + 测试（发版门禁）
npm run dev          # Vite（浏览器预览）
npm run tauri:dev    # Tauri 原生窗口 + 前端 HMR
```

更多命令与约定见 [`docs/dev.md`](docs/dev.md)。

## 打包与发布

```bash
npm run pack:win     # 本机 Windows 桌面包
```

推送 `v*` 标签（或手动触发 Workflow）时，GitHub Actions 会跑门禁并构建 Windows / Linux / macOS 产物，上传到 Release。详见 [`docs/packaging.md`](docs/packaging.md) 与 [`docs/release.md`](docs/release.md)。

## 数据

全部业务数据保存在本机。无云端账号、无业务库上传。

| 环境 | 位置 |
| --- | --- |
| Vite 预览 | 浏览器 `localStorage`（`wb.local.v1`） |
| Tauri 桌面 | `%APPDATA%\my-workbench`（如 `workbench.json`、`prefs.json`） |

知识库正文落在用户选择的本机目录；Agent 工作区绑定所选文件夹路径。断网时任务、日程、知识库、通知与历史会话仍可用；仅调用外部模型需要网络。
