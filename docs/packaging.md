# 打包

当前以 Cargo 发布可执行文件为主：

```bash
cargo build -p wb-app --release
```

产物：`target/release/my-workbench.exe`（Windows）。

可选后续：用 WiX / NSIS / cargo-packager 包装安装器；发版流程见 [`release.md`](release.md)。

依赖本地 `gpui-kit` 时，CI / 发版机需同时检出 `gpui-kit` 到相对路径 `../gpui-kit`，或在 `Cargo.toml` 中改为 crates.io 版本。
