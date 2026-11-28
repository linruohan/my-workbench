//! hadron 蜂群守护进程的启动壳。
//!
//! 与 `my-workbench` 同包编译，因此发布/调试产物会落在同一目录：
//! 工作台按 `current_exe()` 的同级目录寻找 `wb-gluon`。
#[tokio::main]
async fn main() {
    hadron_gluon::cli::run().await
}
