# DSH 工具链 Rust 重写可行性分析

> 分析对象：`C:\software\nodejs\npm_global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`
> 分析日期：2026-11-06　版本快照：`@deepseek-ai/dsh@0.2.2-rc.1`（`engines.node >= 24.9.0`，bin = `dsh` → `lib/bin.js`，顶层 90 个直接依赖）

---

## 1. 结论先行

| 问题 | 结论 |
| --- | --- |
| 能否用 Rust 实现更高性能、跨平台的工具？ | **能，但只对一部分工具成立**。329 个自有包中，约 **25~30 个"系统边界/数据密集"包**是高价值 Rust 迁移对象；约 **40 个**是可选迁移；其余为编排逻辑、协议层和浏览器 UI，**不应迁移**。 |
| 能否保持原有功能不丢失？ | **能**。该仓库天然采用 **seam（抽象接口）+ 实现包** 的分层架构，只要 seam 接口、`.d.ts` 类型面、错误分类词汇、fail-closed 探测语义和 2136 个 locale 文件不变，实现层可以从 JS/koffi 整体替换为 Rust 而不损失任何对外功能。 |
| 最大性能/工程质量收益来自哪里？ | ① 7 处 koffi FFI（Win32/POSIX）→ `windows-rs`/`napi-rs`，运行时布局断言变编译期保证；② 明确注释"阻塞事件循环"的 `spawnSync` 探测 → 异步；③ chokidar → notify；④ 纯 JS 压缩（fflate/brotli/pako）→ `flate2`/`brotli`；⑤ JSONL 会话日志流式解析 → `serde_json`；⑥ 三大平台沙箱后端统一为一份 `cfg(unix)/cfg(windows)` 代码。 |
| 最大风险？ | 沙箱与 Job Object 属**安全关键路径**（fail-closed 语义），以及 Cordis 动态插件宿主是"运行时加载 JS 插件"的系统 —— 这两块必须用契约测试 + 灰度双跑来保证功能零丢失。 |

---

## 2. 规模与构成（实测数据）

### 2.1 体量

| 指标 | 数值 |
| --- | --- |
| 自有包（`node_modules/@deepseek-ai`） | **329 个** |
| 第三方依赖包（`dsh/node_modules` 顶层） | **201 个** |
| 整包体积 | **737.4 MB** |
| ├─ LibreOffice 预编译引擎（`libreoffice-kit-win32-x64`） | 182.0 MB |
| ├─ 嵌套 `node_modules`（其中 **zod 重复副本 247.8 MB**，含其 src/tests） | 248.5 MB / 40943 文件 |
| └─ 其余（sherpa-onnx、sharp、DevTools 前端等） | ≈307 MB |
| 自有文件总数 | 9129 个 |
| ├─ JS（自有，不含嵌套依赖） | **1211 个 / 67.61 MB** |
| │　├─ 浏览器侧（`client.*.js`、`devtools/`、`dist/`） | 51.37 MB / 312 个 |
| │　│　（含 vendored Chrome DevTools ≈21 MB、pdf.js+excel.js ≈14 MB、Web 前端 bundle ≈5 MB） | |
| │　└─ **宿主侧（真正可能 Rust 化的逻辑）** | **16.25 MB / 899 个** |
| ├─ `.d.ts` 类型声明（公共 API 面） | 2558 个 / 7.26 MB |
| └─ locale JSON（i18n 字典，8 语言 × 各包） | **2136 个** |

> 关键观察：**宿主侧真实业务 JS 只有约 16 MB**，浏览器侧占了自有 JS 的 76%。Rust 迁移的理论上限就是这 16 MB 宿主逻辑中的系统边界部分，而不是 67 MB。

### 2.2 CLI 形态

`dsh <profile>` 启动器（commander），profile 包括 `web` / `tui` / `headless` / `sdk` / `acp` / `rescue`（`desktop` 由 Electron 应用独占），`dsh plugin` 转发 pnpm 管理插件依赖；launcher 只解析自己的 flag，其余 argv 原样下放给内层应用。

---

## 3. 架构速览：为什么这个仓库适合"局部 Rust 化"

```
┌─ 浏览器端 (React / vendored DevTools / pdf.js)         ← 不可迁移（51 MB）
├─ Cordis 插件宿主 + schemastery/zod 校验 + YAML 配置    ← 不可迁移（动态加载 JS 插件）
├─ 编排层：agent-loop / tools / llm / session / workflow  ← 不建议迁移（网络与插件生态主导）
├─ seam 抽象包（接口契约 + .d.ts + 错误词汇）            ← 保留原样（迁移的锚点）
└─ 实现包（系统调用、文件、进程、沙箱、存储、压缩）        ← ★ Rust 迁移目标
```

仓库每个能力都拆成"**抽象 seam 包 + 平台实现包**"，例如：

- `dsh-fs`（抽象）→ `dsh-fs-local` / `dsh-fs-sandbox`
- `dsh-subprocess`（抽象）→ `dsh-subprocess-local`
- `dsh-sandbox`（抽象）→ `dsh-sandbox-local`（bwrap / landlock-run / Seatbelt / Windows ACL）
- `dsh-shell`（抽象）→ `dsh-bash-local` / `dsh-pwsh-local` / `*-sandbox`
- `dsh-terminal`（抽象）→ `dsh-terminal-bash`（node-pty 后端）
- `dsh-session-persistence`（抽象）→ `dsh-session-persistence-jsonl`
- `dsh-web`（抽象）→ `dsh-web-fetch-http` / `dsh-web-search-deepseek`

**这意味着：只要 seam 接口不动，实现包可以整体换成 Rust，上层 329 个包完全无感。** 这是"功能不丢失"的结构性保障。

---

## 4. 现状技术栈盘点

### 4.1 koffi FFI 使用点（7 处，全部是 Windows/POSIX 系统调用）

| 包 | 用途 | 系统 API | 代码规模 |
| --- | --- | --- | --- |
| `dsh-win32-process` | 仓库**唯一**可复用 Win32 绑定表：受限令牌 spawn、管道、Job Object | `CreateProcessW/AsUserW`、`GetExitCodeProcess`、`QueryInformationJobObject`…；运行时断言 `STARTUPINFOW=104`、`PROCESS_INFORMATION=24` | 27 KB JS |
| `dsh-sandbox-windows-acl` | Windows ACL 写限制沙箱（restricted-token + capability-SID 写允许列表） | `CreateRestrictedToken`、ACL 编辑、`CreateProcessAsUserW` | 71 KB JS |
| `dsh-subprocess-local` | 进程枚举与 POSIX 直 exec 路径 | `Process32FirstW/NextW`（断言 `PROCESSENTRY32W=568`）、libc `fcntl`/`execve`、`taskkill` | 140 KB JS |
| `dsh-fs-local` | 原子替换时保留 DACL | `GetFileSecurityW`、`SetFileSecurityW`、`ReplaceFileW` | 内嵌 |
| `dsh-session-persistence-jsonl` | 跨进程原子改名 + 命名信号量写者互斥 | `MoveFileExW`、`CreateSemaphoreW/WaitForSingleObject` | 内嵌 |
| `dsh-host-directory-picker-native` | 原生目录选择对话框 | `user32` 枚举窗口 + **COM 对话框** | 23 KB JS |
| `libreoffice-kit` | LibreOffice 子进程命名管道安全描述符 | `kernel32/advapi32` `SECURITY_ATTRIBUTES` | 内嵌 |

痛点（源码注释自证）：koffi 类型注册表是**进程全局**的（测试要绕）；结构体布局靠**运行时** size 断言；每次调用都有编组开销；POSIX 路径也用 koffi 调 libc，等于在 JS 里手写了一层不完整的 libc 绑定。

### 4.2 已有原生二进制（第三方，非 koffi）

| 组件 | 语言/形态 | 大小 | 消费方 | 备注 |
| --- | --- | --- | --- | --- |
| `@vscode/ripgrep` 1.18.0 | **Rust 已编译** | 每平台 1 个 exe | `dsh-tool-fs-search`（glob/grep 工具） | 现状是 spawn 子进程 + 解析 stdout + 字节上限截断 |
| `node-addon-system` | **C11**（musl 静态，`main.c` 11.7 KB + `flock.c` 5.7 KB） | 0.03 MB | `dsh-sandbox-local`（landlock-run）、`dsh-session-persistence-jsonl`（flock） | 已用 per-platform npm optionalDependencies 分发（Rust 可沿用同一模式） |
| `node-pty` 1.2.0-beta.15 | C++ (ConPTY/utmp) | 12+ prebuilds | `dsh-subprocess-local`、`dsh-terminal-bash` | PTY 后端 |
| `sharp` 0.35.5 | libvips | `@img/sharp-win32-x64` | `dsh-attachment-local` | 图片处理（缩略图/元数据） |
| `sherpa-onnx` | C++/onnxruntime `.node`+DLL | ~数百 MB 级 | `dsh-experimental-speech-to-text-sensevoice` | SenseVoice 本地语音识别，独立子进程 |
| `libreoffice-kit-win32-x64` | **C++ LibreOffice 引擎** | **182 MB** | `dsh-office-to-pdf`、`dsh-skill-office`、`dsoffice` bin | 不可重写（MPL 第三方巨型引擎），Rust 只能接管其 JS 管道封装 |
| `node:sqlite`（Node 内置） | C（SQLite+FTS5） | 内置 | `dsh-session-query-sqlite` | 会话全文检索 |
| `chokidar` 5 | 纯 JS（依赖 fsevents） | — | `dsh-fs-local`、`dsh-credentials-local`、`dsh-hmr`、`dsh-skill-filesystem` | 文件监听 |
| `fflate` / `pako` / `brotli` | **纯 JS** | — | `dsh-session-log-export` 等 | 压缩，Rust 有明确收益 |
| `acorn` + `node:vm` | 纯 JS | — | `dsh-ptc-runtime-node`、`dsh-workflow-ptc` | 解析并执行**用户 JS 脚本**，必须留在 JS |

### 4.3 明确的性能反模式（源码注释）

- `dsh-subprocess-local`：*"each probe is a spawnSync that blocks the event loop and forks"* —— Linux 沙箱探测用同步 spawn 阻塞事件循环。
- `dsh-sandbox-local`：bwrap / seatbelt / 探测全部 `spawnSync`。
- `dsh-tool-fs-search`：每次 glob/grep 都 spawn ripgrep 子进程 + 按 `rawOutputMaxBytes` 上限截断 stdout 再解析。
- 每次 `pwsh`/`bash` 工具调用都新开进程（工具描述自证："Each call runs in a fresh pwsh process"），包装层（缓冲、截断、spill、错误分类）全在 JS。

---

## 5. Rust 适配性分级

### A 级：建议迁移（高收益 / 低耦合 / 接口稳定）

| 包 | 现实现 | Rust 方案 | 迁移收益 |
| --- | --- | --- | --- |
| `dsh-win32-process` | koffi 绑定表 | `windows-rs`（`windows` crate）+ napi-rs 暴露 | 布局断言 → 编译期；消除 koffi 全局注册表问题；句柄生命周期由类型系统管理 |
| `dsh-sandbox-windows-acl` | koffi + YAML | `windows-sys`/`windows` + `napi-rs` | 安全关键路径获得内存安全；restricted-token 语义可直接用 `windows` crate 高层 API |
| `dsh-subprocess-local` | node-pty + koffi + spawnSync | `tokio::process` + Job Object（`jobserver` 语义）+ `nix`/`landlock` | 消除阻塞探测；进程组/kill 升级逻辑一处完成 |
| `node-addon-system`（Landlock + flock） | C11 | 现成 Rust 生态：`landlock` crate、`fs4`/`fd-lock` | 与现有 C 实现同为"独立小二进制/N-API"，迁移成本最低，三平台 CI 统一 |
| `dsh-fs-local` + `dsh-atomic-write` + `dsh-fs-patch` | node:fs + koffi DACL + chokidar + 纯 JS patch 解析 | `std::fs`/`tokio::fs` + `windows`（ReplaceFileW/DACL）+ `notify` + Rust 实现 `parsePatch/applyHunks` | 监听延迟与内存下降；原子替换语义跨平台统一；patch 解析是纯 CPU 逻辑，黄金用例可 1:1 对拍 |
| `dsh-session-persistence-jsonl` | koffi MoveFileEx/信号量 + worker.cjs 557 KB | `serde_json` 流式 + `fs2` 文件锁（替代命名信号量）+ 跨平台 rename | 大会话日志的追加/迁移/重放走原生解析；跨进程互斥不再依赖 Win32 信号量 |
| `dsh-session-query-sqlite` | `node:sqlite` FTS5 | `rusqlite`（FTS5 feature） | 查询计划与 FTS5 分词可调优；仍可保留 `node:sqlite` 作为回退实现 |
| `dsh-tool-fs-search` | spawn `@vscode/ripgrep` + 解析 | **Rust 侧进程内**复用 `ignore`/`globset`/`grep` crate（与 ripgrep 同源） | 省掉每次调用的子进程 spawn 与 stdout 截断；同时保留"外部 rg 模式"开关以对拍 |
| `dsh-hmr` / `dsh-credentials-local` / `dsh-skill-filesystem` | chokidar | `notify`（直接 ReadDirectoryChangesW / inotify / FSEvents） | 事件延迟与 CPU 下降；跨三平台行为一致 |
| 压缩类（`dsh-session-log-export` 等） | fflate / pako / brotli（纯 JS） | `flate2`、`brotli` crate，或编译成 napi addon | 纯 JS 压缩替换为原生，2~5× 吞吐（量级估计，需实测） |
| `dsh-host-webserver` 静态层 / `dsh-host-frontend-static` | Node http + compression | **保持 JS**（见 C 级），仅将 `compression` 换为 Rust `async-compression` 的 napi 封装 | 收益有限，列为可选 |

### B 级：可选迁移（已有原生，收益 = 去依赖/统一/瘦身）

| 包 | 现状 | Rust 选项 | 说明 |
| --- | --- | --- | --- |
| `dsh-terminal-bash` / PTY | node-pty（C++ prebuild） | `portable-pty`（wezterm 系）或 conpty crate | 消除 beta 版 node-pty 依赖；xterm/headless 侧不动 |
| `dsh-experimental-speech-to-text-sensevoice` | sherpa-onnx `.node` + DLL | `sherpa-rs` 或官方 C API 绑定 | 仅当要统一音频管线时做；当前"独立子进程"设计已隔离崩溃面 |
| `dsh-attachment-local` | sharp | `image`/`fast_image_resize` crate | 仅当需要去 libvips 时；sharp 已是原生，收益主要是体积（省一个 ~10 MB 原生包） |
| `libreoffice-kit`（JS 封装 + koffi 管道） | 182 MB C++ 引擎 + JS 管道 | 用 Rust 重写**守护进程侧**（管道、参数编组、`dsoffice` CLI），引擎本体不动 | 降低 koffi 管道维护成本；引擎不可重写 |
| `dsh-util-time`（61 KB，temporal polyfill + rrule） | 纯 JS | `jiff`/`chrono-tz` + `rrule` crate | 纯逻辑，性能收益小，主要是去掉 polyfill 依赖；建议最后做 |
| `dsh-token-meter` | 纯密度估算（非真 BPE） | 不值得 | 已注明"Fixed text-density estimate"，本来就不重 |

### C 级：不迁移（保留 JS）

| 类别 | 代表包 | 原因 |
| --- | --- | --- |
| 浏览器 UI | 全部 `dsh-client-ui-*`、`dsh-web-frontend`、`dsh-experimental-inspector`（vendored DevTools 21 MB）、documentpreview（pdf.js/excel.js 14 MB） | 运行在浏览器；只能 WASM，无性能叙事 |
| 动态插件宿主 | `cordis`、`cordis-plugin-*`、`cosmokit`、`schemastery`、`dsh-cordis-host-runner`、`dsh-hmr` | 系统本质是"运行时加载 JS 插件 + YAML 配置"，Rust 化会杀死插件生态 |
| Agent/LLM 编排 | `dsh-agent`、`dsh-agent-loop`、`dsh-llm*`、`dsh-tools`、`dsh-subagent*`、`dsh-workflow*`、`dsh-compaction*` | 瓶颈在 LLM 网络往返与插件调用，不在 CPU；重写风险极高、收益接近零 |
| 协议/传输 | `dsh-typert-*`、`dsh-api-*`、`dsh-acp`、`dsh-sdk-*`、`dsh-mcp-client`、`ws`/`undici` 封装 | 现有 SDK/协议库绑定 JS 生态 |
| JS 脚本执行 | `dsh-ptc-runtime-node`、`dsh-workflow-ptc`（acorn + node:vm） | 执行对象就是 JavaScript 本身 |
| 纯编排小包 | `dsh-goal`、`dsh-schedule`、`dsh-permission-presets`、`dsh-plan-mode` 等约 200 个 | 无系统调用、无重计算；迁移成本 >> 收益 |

---

## 6. 目标架构方案

### 6.1 三种集成形态对比

| 形态 | 适用 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **① napi-rs 进程内 addon**（推荐主力） | 替换 koffi 绑定表、fs/patch/压缩、进程原语 | 零 IPC 开销；与现有 seam 实现包同进程；类型走 `.d.ts` 透出 | Rust panic 需 `catch_unwind` 兜底；每 Node 大版本需 N-API 兼容（napi-rs 已稳定） |
| **② sidecar 独立进程**（stdio/UDS JSON-RPC） | 高崩溃面/长驻组件（PTY 守护、LibreOffice 管道、大文件解析） | 崩溃隔离；可独立升级；冷启 ~10 ms | IPC 序列化开销；需进程生命周期管理 |
| **③ WASM** | 纯逻辑（patch 解析、时间计算） | 浏览器/Node 双端可用 | 运行时开销抵消收益；大内存场景差 |

**推荐混合方案：**

```
JS seam（不动，全部保留）
   │  调用（与现在完全相同的 import 路径 / .d.ts）
   ▼
实现包（JS 薄壳，保留包名与 package.json exports）
   ├─ 内联 napi addon: @deepseek-ai/dsh-native-*   ← koffi 7 处 + fs + patch + 压缩
   └─ sidecar: dsh-native-runner (Rust bin)        ← PTY 守护 / 大日志解析 / LibreOffice 管道
```

分发沿用仓库**已有先例**：`node-addon-system-linux-{x64,arm64}`、`@img/sharp-win32-x64`、`libreoffice-kit-win32-x64` 的 per-platform npm optionalDependencies 模式 —— napi-rs CLI 原生支持生成同构的 `*-win32-x64-msvc` / `*-linux-x64-gnu` / `*-darwin-arm64` 包。

### 6.2 crate 选型速查

| 领域 | 现有 JS 依赖 | Rust crate |
| --- | --- | --- |
| Win32 API | koffi | `windows` / `windows-sys` |
| N-API 桥 | koffi（反向） | `napi` / `napi-derive`（napi-rs） |
| 进程 | child_process + koffi libc | `tokio::process`、`command-group`、`nix` |
| PTY | node-pty | `portable-pty` |
| 文件监听 | chokidar | `notify` |
| 文件锁/信号量 | koffi CreateSemaphoreW | `fs4`（flock/lockf），Windows 侧 `windows` 命名互斥 |
| JSON/JSONL | JSON.parse / 手写 | `serde_json`（可加 `simd-json`） |
| SQLite FTS5 | node:sqlite | `rusqlite`（bundled, fts5） |
| glob/grep | @vscode/ripgrep（子进程） | `ignore` + `globset` + `grep-searcher`（ripgrep 同源） |
| 压缩 | fflate/pako/brotli | `flate2`、`brotli`、`async-compression` |
| diff | `diff` 9.0 | `similar` / `imara-diff` |
| HTML→MD | turndown + gfm 插件 | `htmd` / `html2text` |
| 会话搜索索引 | minisearch | `nucleo-matcher`（模糊匹配，可选） |
| Landlock/flock | 自研 C | `landlock`、`fs4` |
| 时间/RRULE | @js-temporal/polyfill + rrule | `jiff`、`rrule` crate |
| HTTP 客户端 | undici | **保留 undici**（与 Node 生态、代理、CA 行为一致） |

---

## 7. 逐包迁移映射（重点清单）

| # | 原包 | 保持不变的契约 | Rust 交付物 | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | `dsh-win32-process` | README 中全部原语签名：`spawnPipedProcess` / `spawnInheritedJobProcess` / `spawnCurrentTokenJobProcess` / `pollProcessExit` / `isJobEmpty`；`RestrictedProcessSpawnOptions` 字段 | `native/win32-process`（napi） | P0 |
| 2 | `dsh-sandbox-windows-acl` | restricted-token + capability-SID 写允许列表；`SANDBOX_UNAVAILABLE`、`full/partial` 探测报告、fail-closed | `native/sandbox-acl`（napi） | P0 |
| 3 | `node-addon-system` | `landlock-run [--ro]… [--rw]… -- argv`、`--probe`、退出码与 stderr 报告行（`docs/cli-contract.md` 已钉死）；`flock` 异步语义 | Rust bin + napi，**CLI 契约逐字节兼容** | P0 |
| 4 | `dsh-subprocess-local` | 进程组、spill 有界输出、升级 kill、POSIX 直 exec、taskkill 路径、systemd-run scope | `native/subprocess`（napi） | P0 |
| 5 | `dsh-fs-local` / `dsh-atomic-write` / `dsh-fs-patch` | `FsError` 错误码（ENOENT/EACCES/EIO…）、version-guarded 写、DACL 保留、`parsePatch/applyHunks` 结构化失败 | `native/fs`（napi）+ 黄金用例对拍 | P1 |
| 6 | `dsh-session-persistence-jsonl` | JSONL 行格式、原子改名、跨进程写者互斥、`worker.cjs` 后台写 | `native/jsonl`（napi 或 sidecar） | P1 |
| 7 | `dsh-tool-fs-search` | `SearchError` 词汇（`SEARCH_INVALID_PATTERN` 等）、`rawOutputMaxBytes` 截断语义、错误分类正则 | 进程内 `ignore/globset` + 可选 `--backend=external-rg` 对拍开关 | P1 |
| 8 | `dsh-session-query-sqlite` | FTS5 查询语义、索引 schema | `rusqlite` napi，schema 迁移脚本复用 | P2 |
| 9 | `dsh-hmr`/`dsh-credentials-local`/`dsh-skill-filesystem`/`dsh-fs-local` watch | chokidar 事件语义（add/change/unlink、awaitWriteFinish 行为需对拍） | `notify` napi | P2 |
| 10 | 压缩（session-log-export 等） | ZIP/deflate 字节兼容 | `flate2` napi | P2 |
| 11 | `dsh-terminal-bash` PTY | xterm/headless 上游数据帧不变 | `portable-pty` sidecar | P3（可选） |
| 12 | `libreoffice-kit` JS 管道 | `dsoffice` CLI 参数与输出、转换/渲染结果 | Rust supervisor（引擎不动） | P3（可选） |

**明确不迁移**（前文 C 级）：cordis/schemastery/zod 宿主、agent/LLM/tools 编排、全部 `client-*`、inspector、PTC 运行时。

---

## 8. 跨平台收益分析

**现状：三平台实现是三套拼接**

| 平台 | 进程 | 沙箱 | 文件监听 | 原子写 |
| --- | --- | --- | --- | --- |
| Windows | koffi（CreateProcessW/Job）+ taskkill + node-pty(ConPTY) | ACL restricted-token（koffi） | chokidar（ReadDirectoryChangesW） | koffi ReplaceFileW/MoveFileExW + DACL 保留 |
| Linux | node:spawn + koffi libc execve + systemd-run | bwrap / landlock-run（自研 C） | chokidar（inotify） | rename + flock（自研 C） |
| macOS | node:spawn | Seatbelt `sandbox-exec` | chokidar（FSEvents） | rename + flock |

**Rust 迁移后**：一份代码 `#[cfg(windows)] / #[cfg(unix)]`，`windows` crate / `nix` crate / `landlock` crate / `notify` 各自封装平台差异；CI 三平台跑同一套契约测试。收益是**工程性**的（少 7 处 koffi 绑定、少 2 个自研 C 文件、少 3 套探测逻辑），不是"Windows 上快多少"——koffi 调用本身很快，真正的性能收益在 §4.3 列出的阻塞点。

---

## 9. 功能零丢失保障机制

1. **seam 不动**：抽象包（`dsh-fs`、`dsh-subprocess`、`dsh-sandbox`、`dsh-terminal`、`dsh-session-persistence`…）及其 `.d.ts` 原样保留；329 个上层包的 import 路径、`package.json exports` 不变。
2. **错误词汇逐条对齐**：`FsError` 码表、`SANDBOX_UNAVAILABLE`、`SearchError` 分类、`[sandbox: file access denied under <mode> mode]`、`[exit code: N]` 等对外可观察字符串进入契约测试。
3. **fail-closed 语义**：沙箱探测不可用时必须非零退出且不执行命令（landlock-run 源码已明文规定）——迁移时作为一等测试用例。
4. **黄金文件对拍（golden files）**：patch 解析、JSONL 读写与 v0→v4 迁移、rg 输出解析、压缩字节、时间/RRULE 计算 —— JS 版与 Rust 版对同一输入输出必须逐字节一致（时间类允许显式白名单差异）。
5. **FFI 布局断言转编译期**：`STARTUPINFOW=104`、`PROCESS_INFORMATION=24`、`PROCESSENTRY32W=568` 这些运行时检查在 Rust `windows` crate 中由 `#[repr(C)]` + 编译期测试保证；保留等价的启动期 sanity check。
6. **locale / i18n 不动**：2136 个 locale JSON 完全保留，Rust 侧只读不产文案（或经 `include_str!` 复用同一份）。
7. **灰度双跑**：`DSH_NATIVE_BACKEND=rust|legacy` 环境开关，Rust 实现先作为默认、JS/koffi 实现保留一个版本周期；异常自动回退。
8. **分发兼容**：per-platform npm optionalDependencies + `os/cpu` 字段，Node 版本要求维持 `>=24.9.0` 不变（napi-rs 产物对 Node 24 稳定）。

---

## 10. 实施路线图

| 阶段 | 内容 | 产出 | 估算（人周，量级） |
| --- | --- | --- | --- |
| **Phase 0** | 搭 `native/` workspace：napi-rs 脚手架、per-platform 打包、CI 三平台矩阵、契约测试框架（golden 对拍 harness） | 可发布的空 addon + 测试跑通 | 2~3 |
| **Phase 1** | A 级系统边界：`win32-process` → `sandbox-windows-acl` → `subprocess-local` → `node-addon-system` | 消灭 4 个最高风险 koffi/C 面 | 6~10 |
| **Phase 2** | 数据面：`fs-local`+`fs-patch`+`atomic-write`、`session-persistence-jsonl`、`tool-fs-search` 进程内化 | 事件循环不再被 spawnSync 阻塞；glob/grep 零子进程 | 5~8 |
| **Phase 3** | 生态面：chokidar→notify、压缩、sqlite、（可选）PTY/LibreOffice 管道 | 依赖瘦身（去 koffi、chokidar、fflate/pako） | 4~6 |
| **Phase 4** | 收尾：legacy 路径下线评估、体积审计（顺带处理 247.8 MB 重复 zod 副本问题）、性能基线报告 | 稳定版 | 2~3 |

合计量级：**19~30 人周**（单人全职约 5~7 个月）。若只做 Phase 0+1（koffi/C 替换），**8~13 人周**即可拿到大部分工程质量收益。

### 风险清单

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| Windows ACL 沙箱语义漂移（安全关键） | 高 | fail-closed 契约测试 + 生产灰度双跑 + 渗透式用例（写允许列表逃逸尝试） |
| Job Object/句柄泄漏 | 中 | Rust 所有权模型天然改善；保留 handle 计数断言测试 |
| napi addon panic 拖垮 Node | 中 | `catch_unwind` 边界 + 关键路径走 sidecar |
| chokidar→notify 事件语义差异 | 中 | 事件序列对拍；保留 chokidar 回退开关 |
| 双实现维护成本 | 中 | legacy 路径设定明确下线版本 |
| 收益不及预期（编排层无变化） | 低 | 分阶段投入，每阶段可独立止损 |

---

## 11. 最终结论

1. **可行**：仓库的 seam 架构 + per-platform npm 分发先例，使得"上层 329 个包零改动、只换实现层"的 Rust 迁移在结构上是成立的；**功能不丢失**有明确的工程保障路径（契约测试、黄金对拍、灰度双跑、`.d.ts`/locale 不动）。
2. **值得做的部分很集中**：真正高收益的是 **7 处 koffi FFI、1 个自研 C 原生包、PTY/subprocess/沙箱/文件监听/JSONL/压缩/glob-grep** 这约 12~20 个包（宿主侧 16 MB JS 中的系统边界部分），而不是全部 329 个包。
3. **性能收益的真实来源**是：消除 `spawnSync` 事件循环阻塞、子进程化 glob/grep 进程内化、原生 JSON/压缩/文件监听、FFI 编组与运行时布局检查消失 —— 而**不是**"Rust 比 JS 快"这个笼统命题；Agent/LLM/插件编排层（网络主导）与浏览器 UI（76% 的自有 JS）不在受益面内。
4. **跨平台收益主要是工程统一**：三平台的进程/沙箱/监听/原子写四套拼接实现收敛为一份 `cfg` 分支代码 + 同一套 CI 契约测试，同时消灭 koffi 全局类型注册表、运行时结构体断言等已知痛点。
5. **建议**：按 Phase 0→1 先行（8~13 人周拿到 koffi/C 面的全部工程质量收益），用灰度开关验证后再推进 Phase 2 的数据面迁移；C 级包（插件宿主、编排、UI）**保持 JS 不动**。
