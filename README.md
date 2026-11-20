# 个人工作台 (my-workbench)

本地优先的桌面个人工作台（**Rust + GPUI + gpui-kit**）。任务、定时任务、知识库、Agent、提醒与通知共用一套本机数据，不设云端账号，业务数据只落本机。

当前版本 `0.1.14`。

| 文档 | 说明 |
| --- | --- |
| [`docs/design.md`](docs/design.md) | 产品与架构设计 |
| [`docs/dev.md`](docs/dev.md) | 日常开发约定 |
| [`docs/packaging.md`](docs/packaging.md) | 打包与发版操作 |
| [`docs/release.md`](docs/release.md) | 发布标准 |
| [`docs/tools.md`](docs/tools.md) | Agent 工具面 |

## 结构

```
crates/wb-app      GPUI 窗口与界面（入口二进制 my-workbench）
crates/wb-domain   无 IO 的领域规则
crates/wb-store    内存仓储 + workbench.json / prefs.json 持久化
crates/wb-host     原生能力（kb 文件、shell、HTTP、语音 PTT、字体）
crates/wb-agent    Agent 回合、工具分派、Provider
```

UI 依赖本地 [`../gpui-kit`](../gpui-kit)（path：`../gpui-kit/crates/kit`）。

## 功能概览

- **任务**：今日 / 收件箱 / 已完成 / 计划 / 项目；快速捕获；提醒扫描
- **定时任务**：预设节奏、立即执行、到期投递通知
- **知识库**：本机目录建库、文件树、Markdown 编辑
- **Agent**：工作区、会话、内置与 OpenAI 兼容 Provider、斜杠工具（`/task_list` 等）
- **设置**：主题、HTTP 代理、语音、Provider、数据目录
- **命令面板**：`Ctrl+P` / `Ctrl+K`

数据目录：`%APPDATA%\my-workbench\`（`workbench.json`、`prefs.json` 等），与旧 Tauri 版本兼容。

## 开发

环境要求：Rust stable、Visual Studio Build Tools（C++ 桌面开发）、本地检出 [`gpui-kit`](../gpui-kit) 于 `D:\codehub\gpui-kit`（或相对本仓库 `../gpui-kit`）。

```bash
cargo run -p wb-app          # 启动桌面应用
cargo test --workspace       # 单元测试
cargo fmt --check && cargo clippy --workspace -- -D warnings && cargo test --workspace
```

发版门禁见 [`.cursor/rules/commit-gate.mdc`](.cursor/rules/commit-gate.mdc)。
