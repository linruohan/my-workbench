# 打包说明

本文说明如何把个人工作台打成可分发的 Windows 桌面安装包 / 可执行文件。所有业务数据仍只保存在用户本机，安装包本身不包含用户库。

## 环境要求

| 依赖 | 版本建议 | 用途 |
| --- | --- | --- |
| Node.js | ≥ 20 | 前端与 workspace |
| npm | 随 Node | 安装依赖 |
| Rust | stable / nightly 均可（需 `cargo`） | Tauri 原生壳 |
| Visual Studio Build Tools | 含「使用 C++ 的桌面开发」 | Windows 链接 |
| WebView2 | Windows 10/11 通常已带 | Tauri 渲染 |

首次打包前：

```bash
npm install
npm test
rustc --version
cargo --version
```

## 开发态（不打包）

```bash
# 仅 Vite（浏览器 / WebView 预览，localStorage 持久化）
npm run dev

# Tauri 开发壳（热更新前端 + 原生窗口）
npm run tauri:dev
```

桌面壳下，数据与设置默认目录：

`%APPDATA%\my-workbench`  
（本机示例：`C:\Users\Administrator\AppData\Roaming\my-workbench`）

目录内文件：`workbench.json`（业务快照）、`prefs.json`（设置）、`theme.json`（主题）。


发版门禁与版本规范见 [`release.md`](release.md)。代码规范见 [`standards.md`](standards.md)。

## 生产构建

### 1. 仅前端静态资源

```bash
npm run build
```

产物在 `apps/desktop/dist/`，供 Tauri 嵌入或单独预览：

```bash
npm run preview -w @wb/desktop
```

### 2. Windows 桌面包（推荐）

```bash
npm run pack:win
```

等价于：

```bash
npm run tauri:build -w @wb/desktop
```

产物目录（以本机 Tauri 配置为准）：

```
apps/desktop/src-tauri/target/release/bundle/
  msi/          # Windows Installer（若启用）
  nsis/         # NSIS 安装包（若启用）
  ...
apps/desktop/src-tauri/target/release/
  my-workbench.exe   # 或 productName 对应的可执行文件
```

具体文件名以 `apps/desktop/src-tauri/tauri.conf.json` 中 `productName`（当前为 `My Workbench`）为准。

### 3. 校验清单（发版前）

- [ ] `npm test` 全部通过
- [ ] 冷启动后能进入「今日」
- [ ] 新建无日期任务进入收件箱，不进入今日
- [ ] 排到今天后出现在今日；设具体时刻后离开计划列
- [ ] 数据目录仍在本机（复制用户数据目录可备份）
- [ ] 断网下任务 / 日程 / 通知可读可写（不调用外部模型时）

## 用户数据位置

- **Vite 开发预览**：浏览器 `localStorage` 键 `wb.local.v1`
- **后续 Tauri + SQLite**：应用数据目录下的 `workbench/workbench.db`（见设计文档）

卸载安装包不会自动声明「云端有备份」——本产品无云端业务库。

## 常见问题

**`better-sqlite3` 安装失败**  
确保已批准 install scripts，并具备 VS Build Tools；或在仓库根目录执行 `npm rebuild better-sqlite3`。

**`tauri build` 找不到图标 / 前端**  
确认 `apps/desktop/src-tauri/tauri.conf.json` 中 `build.frontendDist` 为 `../dist`，且已先成功 `vite build`。

**杀毒软件拦截未签名安装包**  
开发阶段安装包通常未做代码签名；对内分发可加签名证书后再发正式版。
