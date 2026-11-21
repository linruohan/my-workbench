# 打包

当前以 Cargo 发布可执行文件为主：

```bash
cargo build -p wb-app -p wb-asr --release
```

产物（Windows）：

- `target/release/my-workbench.exe` — 主程序
- `target/release/wb-asr.exe` — SenseVoice 转写助手（与主程序同目录分发）
- sherpa-onnx shared 运行时 DLL（构建 `wb-asr` 时会拷到 `target/release/`，需一并打包）

可选后续：用 WiX / NSIS / cargo-packager 包装安装器；发版流程见 [`release.md`](release.md)。

依赖本地 `gpui-kit` 时，CI / 发版机需同时检出 `gpui-kit` 到相对路径 `../gpui-kit`，或在 `Cargo.toml` 中改为 crates.io 版本。
