# 个人工作台 (my-workbench)

本地优先的桌面个人工作台。主体能力：任务、日程、知识库、Agent、提醒、通知。

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
apps/desktop     Tauri 2 + React 界面
packages/domain  领域规则
packages/db      SQLite / 内存仓储
packages/theme   统一设计令牌与主题解析
```

## 开发

```bash
npm install
npm run check        # 格式 + lint + 类型 + 测试（发版门禁）
npm run dev          # Vite
npm run tauri:dev    # Tauri 窗口
```

侧栏「主题」可在跟随系统 / 浅色 / 深色间切换，偏好保存在本机。

侧栏「知识库」可新建 Markdown 笔记，支持 Typora 风格的**实时**（左右分屏即时预览）、**源码**、**预览**三种模式。

## 打包

```bash
npm run pack:win
```

见 [`docs/packaging.md`](docs/packaging.md) 与 [`docs/release.md`](docs/release.md)。

## 数据

全部业务数据保存在本机。无云端账号、无业务库上传。
