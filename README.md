# 个人工作台 (my-workbench)

本地优先的桌面个人工作台。主体能力：任务、日程、知识库、Agent、提醒、通知。

| 文档 | 说明 |
| --- | --- |
| [`docs/design.md`](docs/design.md) | 产品与架构设计 |
| [`docs/packaging.md`](docs/packaging.md) | 打包与发版 |
| [`docs/dev.md`](docs/dev.md) | 日常开发约定 |
| [`开发报告.md`](开发报告.md) | 完整开发日志与阶段报告 |

## 结构

```
apps/desktop     Tauri 2 + React 界面
packages/domain  纯 TypeScript 领域规则
packages/db      SQLite 与内存仓储（数据仅本机）
```

## 开发

```bash
npm install
npm test
npm run dev          # Vite 界面（localStorage 持久化）
npm run tauri:dev    # Tauri 开发窗口（需 Rust）
```

## 打包

```bash
npm run pack:win     # Windows 桌面生产包（Tauri build）
```

细节见 [`docs/packaging.md`](docs/packaging.md)。

## 测试

```bash
npm test                 # domain + db + desktop（当前 29 项）
```

覆盖：计划日/时刻互斥、今日成员、提醒与通知冷却、计时、快速捕获、SQLite/Memory 仓储、界面捕获与排期。

## 数据

全部业务数据保存在本机。无云端账号、无业务库上传。详见设计文档「本地数据边界」。
