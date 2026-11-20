# 开发约定

## 环境

- Rust stable（见根目录 `rust-toolchain.toml`）
- 本机旁路仓库：`../gpui-kit`（Longbridge GPUI Kit 0.10）
- Windows：VS Build Tools（C++ 桌面开发）

## 常用命令

```bash
cargo run -p wb-app
cargo check --workspace
cargo test --workspace
cargo fmt
cargo clippy --workspace -- -D warnings
```

## Crate 边界

| Crate | 可依赖 | 禁止 |
| --- | --- | --- |
| `wb-domain` | 标准库 / serde / chrono | IO、gpui、网络 |
| `wb-store` | `wb-domain`、文件系统 | gpui、UI |
| `wb-host` | `wb-domain`、`wb-store`、系统 API | gpui UI 组件 |
| `wb-agent` | domain / store / host | gpui |
| `wb-app` | 以上全部 + `gpui-kit` | — |

## 数据

- 快照：`%APPDATA%\my-workbench\workbench.json`
- 偏好：`prefs.json`
- Provider：`providers.json`
- 密钥：`credentials.json`
- 语音模型：`models/<engine>/`

JSON 字段名保持 camelCase，与历史 Tauri 快照兼容。

## 提交

提交前跑门禁：

```bash
cargo fmt --check && cargo clippy --workspace -- -D warnings && cargo test --workspace
```
