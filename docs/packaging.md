# 打包与发版操作

## 1. 前置条件

- Node.js ≥ 20；`npm install` 在仓库根执行。
- Rust ≥ 1.90（`rustup default stable`）+ MSVC 工具链。
- Visual Studio Build Tools「使用 C++ 的桌面开发」。
- WebView2 Runtime（Windows 11 自带；Win10 需安装）。
- 首次打包需要联网下载 Tauri CLI 缓存、NSIS / WiX 工具与 Rust crates。

## 2. 版本与标识

| 文件 | 字段 |
| --- | --- |
| `package.json` | `version` |
| `apps/desktop/package.json` | `version` |
| `apps/desktop/src-tauri/tauri.conf.json` | `version`、`productName`、`identifier`、窗口标题 |
| `apps/desktop/src-tauri/Cargo.toml` | `version` |
| `开发报告.md` | 末尾修订记录 |

发版前四处版本号必须一致；当前为 `0.1.10`，标识 `com.myworkbench.app`，产品名 `My Workbench`，窗口标题「个人工作台」。

## 3. 本机打包

```bash
npm run check          # 门禁：格式 / lint / 类型 / 测试
npm run build          # 前端产物 apps/desktop/dist
npm run pack:win       # Tauri bundle（Windows）
```

`pack:win` 实际执行 `tauri build -w @wb/desktop`，`bundle.targets = "all"`：

- 产物目录：`apps/desktop/src-tauri/target/release/bundle/`
  - `nsis/*.exe`（推荐分发）
  - `msi/*.msi`
- 可执行文件：`apps/desktop/src-tauri/target/release/app.exe`
- 仅调试前端可 `npm run build && npm run preview -w @wb/desktop`。

只想验证前端可运行：`npm run dev`（浏览器，无原生能力）。

## 4. 随包资源

`tauri.conf.json > bundle.resources` 固定打包：

- `resources/speech/transcribe.mjs`：语音转写 Node 桥。
- `resources/speech/funasr_worker.py`：Fun-ASR-Nano-GGUF worker。
- `resources/speech/qwenctc_worker.py`：QwenCTC worker。
- `resources/speech/runtimes/`：`fun_asr_gguf`、`qwen_ctc` 的 Python 运行时与推理代码。
- `resources/speech/assets/qwenctc/`：分词与配置资产。

**不随包**：PaddleOCR 模型、SenseVoice / Fun-ASR / QwenCTC 权重。首次在「设置 · 语音输入」或首次识图时下载到数据目录，安装包因此保持较小。

Office 转 PDF 由 `apps/desktop/scripts/office-to-pdf.mjs` 调用 `@deepseek-ai/libreoffice-kit`；该依赖不在安装包资源内，缺失时工具返回明确错误，不影响其他能力。

## 5. 数据目录

`%APPDATA%\my-workbench\`

| 文件 / 目录 | 用途 |
| --- | --- |
| `workbench.json` | 业务快照（任务 / 项目 / 标签 / 笔记 / 定时任务 / Agent 会话与消息 / 通知） |
| `prefs.json` | 常规设置、Agent 个性化、记忆、钩子、子智能体、命令、MCP、技能与插件偏好 |
| `theme.json` | 主题 |
| `models/paddleocr` | OCR det / rec / 字典 |
| `models/sensevoice` `models/funasr` `models/qwenctc` | 本地语音模型 |
| `logs/` | Tauri 日志（若启用） |

- Provider 列表与 API Key 在 WebView `localStorage`，不在上述目录。
- 知识库正文在用户选择的本机目录，不在应用数据目录。
- 工作区 Agent 溢出文件在 `<工作区>\.wb\spill\`。
- 升级 / 卸载不会自动删除 `%APPDATA%\my-workbench`；备份整个目录即可。

## 6. CI 发布

`.github/workflows/release.yml`：

1. `check` job：`npm ci` → `npm run check`。
2. 矩阵构建：Windows、Linux、macOS（Intel 与 Apple Silicon）。
3. 运行 `scripts/release-notes.mjs` 生成 Release Notes。
4. `tauri-action` 构建并上传 bundle，创建 / 更新 GitHub Release。

触发：推送 `v*` 标签或手动 `workflow_dispatch`。版本号与标签必须一致，否则安装包文件名与 Release 标题会不一致。

## 7. 打包后自检

- 冷启动进入今日视图，无白屏、无控制台报错。
- 新建任务、切看板、开统计、拖拽列正常。
- 切换项目、计划视图、定时任务新建与「立即执行」正常。
- 选择知识库目录、打开 Markdown、编辑保存并在磁盘看到变更；文件树重命名 / 删除正常。
- 设置里切换主题并重启仍保留；字体扫描返回本机字体。
- Agent：新建工作区、发一条消息、权限审批卡出现；模型连通性测试通过（如已配置）。
- 语音与 OCR：未下载时提示清晰；下载后可离线转写 / 识图。
- 关闭应用再打开，`workbench.json` 数据完整；删除 data 目录后可回到首次启动状态。

## 8. 排障

| 现象 | 处理 |
| --- | --- |
| `link.exe not found` | 安装 VS Build Tools C++ 桌面开发，重开终端 |
| WebView2 空白 | 安装 / 修复 WebView2 Runtime |
| 打包卡在下载 NSIS / WiX | 检查网络与代理；删除 `target` 后重试 |
| 语音提示未就绪 | 检查 `models/<engine>` 是否下载完整、Python worker 是否被杀软拦截 |
| OCR 无结果 | 确认 `models/paddleocr` 三个文件齐全；首次识别需加载 WASM |
| 知识库无法写盘 | 目录需有写权限；Tauri 自定义命令不走 `fs:scope`，但仍受系统 ACL 限制 |
| 模型请求失败 | 检查「设置 · 模型」端点、Key、代理；Rust 侧 `model_http` 有超时与错误透传 |
| Office 转 PDF 失败 | 安装 `@deepseek-ai/libreoffice-kit` 或设置 `WB_LIBREOFFICE_KIT` |

## 9. 安全边界

- `csp` 当前为 `null`（便于内嵌网页与远程资源）；发版前若要启用 CSP，需同步验证 Agent 网页会话、Office 转 PDF 结果与图片 data URL。
- `capabilities/default.json` 的 `fs:scope` 只允许 `$DATA/my-workbench`；知识库与工作区文件通过自定义 Rust 命令访问，新增命令必须在 `lib.rs` 注册并评估路径校验。
- 安装包不包含任何 API Key、Provider 配置或用户数据。
