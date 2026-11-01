# 代码规范

本文件是个人工作台的**强制编码标准**。发版前须通过根目录 `npm run check`。

## 1. 总则

1. TypeScript **strict**；禁止无必要的 `any`。
2. 业务规则放在 `@wb/domain`，持久化放在 `@wb/db`，视觉令牌放在 `@wb/theme`，UI 不复制不变量。
3. **所有业务数据只写本机**；不得引入云端业务库或静默上传。
4. 改行为必补测试；修 bug 优先加回归测试。
5. 提交信息说明「为什么」；不提交 `node_modules`、`target`、`*.db`、凭据。

## 2. 目录与依赖方向

```
apps/desktop  →  @wb/domain, @wb/db/memory|@wb/db, @wb/theme
packages/db   →  @wb/domain
packages/theme → （无业务依赖）
packages/domain → （无 UI / IO 依赖）
```

禁止：`domain` 依赖 `desktop`；禁止 UI 直接拼 SQL。

## 3. 命名

| 类别 | 约定 |
| --- | --- |
| 文件 | `kebab-case.ts` / 组件 `PascalCase.tsx` |
| 类型 / 组件 | `PascalCase` |
| 函数 / 变量 | `camelCase` |
| 常量 | `UPPER_SNAKE` 或只读对象 |
| CSS 类 | BEM 风格：`block__element`、`is-active` |
| CSS 变量 | `--wb-*`（仅来自 `@wb/theme`） |

## 4. React / UI

1. 主题必须经 `ThemeProvider`；颜色与间距只用 `--wb-*`，禁止在功能 CSS 写死色值（测试夹具除外）。
2. 列表将来大数据量用虚拟滚动；禁止为装饰引入持续占用主线程的动画。
3. `prefers-reduced-motion` 已在主题中归零动效，勿绕过。
4. 无障碍：按钮有可见文案或 `aria-label`；提醒弹层使用适当 `role`。

## 5. 测试

| 包 | 最低要求 |
| --- | --- |
| `@wb/domain` | 每个导出模块有单测；不变量变更必须改测 |
| `@wb/db` | 仓储关键路径有集成测（内存 SQLite / Memory） |
| `@wb/theme` | 解析、持久化、cycle 有单测 |
| `@wb/desktop` | 主路径交互测（捕获、排期、主题切换） |

命令：`npm test`

## 6. 格式与静态检查

- EditorConfig：`.editorconfig`
- Prettier：`.prettierrc`
- Oxlint（desktop）：`apps/desktop/.oxlintrc.json`

```bash
npm run format        # 写入格式化
npm run format:check  # CI / 发版检查
npm run lint          # oxlint desktop
npm run typecheck
npm run check         # format:check + lint + typecheck + test
```

## 7. Git

- 默认分支 `main`
- 提交前本地 `npm run check`（发版强制）
- 不使用 `--no-verify` 跳过约定（除非紧急热修并事后补测）

## 8. 相关文档

- 设计：`docs/design.md`
- 主题实现：`packages/theme`
- 发布标准：`docs/release.md`
- 打包：`docs/packaging.md`
