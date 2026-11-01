# 开发记录

日常开发约定与本地流程。完整阶段回顾见根目录 [`开发报告.md`](../开发报告.md)。

## 仓库约定

- 包管理：npm workspaces（`apps/*`、`packages/*`）
- 语言：TypeScript strict
- 测试：Vitest（domain / db / desktop）
- 桌面壳：Tauri 2 + React 19 + Vite
- 数据：本机 only（SQLite / localStorage），无云端业务库

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm install` | 安装全部 workspace 依赖 |
| `npm test` | domain + db + theme + desktop 测试 |
| `npm run check` | 发版门禁：format + lint + typecheck + test |
| `npm run format` | Prettier 格式化 |
| `npm run lint` | Oxlint（desktop） |
| `npm run dev` | Vite 热更新（浏览器模拟桌面 UI） |
| `npm run tauri:dev` / `dev:desktop` | Tauri 热启动（原生窗口 + 前端 HMR） |
| `npm run build` | 构建前端 |
| `npm run pack:win` | Windows 桌面生产包 |

### 热启动桌面端

推荐日常改 UI / 领域代码时用 Tauri 热启动（改前端会 HMR，不必重编 Rust）：

```bash
npm run tauri:dev
# 或
npm run dev:desktop
```

仅预览界面、不需要原生能力时：

```bash
npm run dev
# 浏览器打开 http://localhost:5173
```

Cursor / VS Code：运行与调试里可选「桌面端 · Tauri 热启动」或「桌面端 · Vite 热更新（模拟）」；也可 `任务: 运行任务` → 同名任务。

`apps/desktop/vite.config.ts` 已把 `packages/domain|db|theme` 纳入监视与 `fs.allow`，改领域代码也会热更新进桌面壳。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `docs/design.md` | 产品与架构设计（权威） |
| `docs/standards.md` | 代码规范 |
| `docs/release.md` | 发布标准 |
| `docs/packaging.md` | 打包操作 |
| `docs/dev.md` | 本文：日常开发 |
| `开发报告.md` | 阶段总结与决策日志 |
| `packages/domain` | 无 IO 的领域规则 |
| `packages/db` | SQLite / 内存仓储 |
| `packages/theme` | 设计令牌与主题解析 |
| `apps/desktop` | UI + Tauri |

## 开发顺序建议

1. 先在 `packages/domain` 写规则与单测（不碰 UI）
2. 在 `packages/db` 落库并做集成测
3. 在 `apps/desktop` 接界面与交互测
4. 需要原生能力时再扩 `src-tauri`

## Git

- 本地仓库，默认分支 `main`
- 提交信息用中文或英文均可，说明「为什么」
- 勿提交：`node_modules/`、`target/`、`*.db`、凭据、`.env`

## 变更时更新文档

- 改领域不变量 → 同步 `docs/design.md` 与相关测试
- 改打包方式 → 同步 `docs/packaging.md`
- 完成一个可交付阶段 → 在 `开发报告.md` 追加一节
