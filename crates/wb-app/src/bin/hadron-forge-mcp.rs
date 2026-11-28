//! hadron 守护进程交给每个 ACP 座位的 stdio MCP 服务器启动壳。
//!
//! 与 `hadron-gluon` 同包编译，确保守护进程能在自己的 `current_exe()` 同级
//! 目录找到它。
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    hadron_forge_mcp::run().await
}
