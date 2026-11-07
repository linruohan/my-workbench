//! Kill-on-close process trees for agent shell / office jobs.
//! Windows: unnamed Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
//! Unix: child process group + `kill(-pgid, SIGKILL)`.

use std::process::{Child, Command};

/// Owns OS resources that can terminate an entire spawned tree.
pub struct ProcessTree {
    #[cfg(windows)]
    job: Option<WinJob>,
    #[cfg(unix)]
    pgid: Option<i32>,
}

impl ProcessTree {
    /// Apply spawn flags so the child can form / join a killable tree.
    pub fn prepare(cmd: &mut Command) {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            // Prefer a fresh process group so AssignProcessToJobObject can own the tree.
            // Skip CREATE_BREAKAWAY_FROM_JOB — many hosts disallow breakaway and spawn fails.
            cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Make the child the leader of a new process group.
            cmd.process_group(0);
        }
        let _ = cmd;
    }

    /// After `spawn`, bind the child into the killable tree.
    pub fn bind(child: &Child) -> Self {
        #[cfg(windows)]
        {
            let job = WinJob::create_kill_on_close()
                .and_then(|job| {
                    job.assign_child(child)?;
                    Ok(job)
                })
                .ok();
            Self { job }
        }
        #[cfg(unix)]
        {
            let pgid = Some(child.id() as i32);
            Self { pgid }
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = child;
            Self {}
        }
    }

    /// Hard-stop the whole tree, then ensure the direct child is reaped.
    pub fn kill_tree(&mut self, child: &mut Child) {
        #[cfg(windows)]
        {
            if let Some(job) = self.job.take() {
                job.terminate(1);
            }
        }
        #[cfg(unix)]
        {
            if let Some(pgid) = self.pgid.take() {
                unsafe {
                    // Negative pid = process group (POSIX).
                    let _ = kill(-pgid, SIGKILL);
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        // Closing a kill-on-close Job terminates any remaining members.
        #[cfg(windows)]
        {
            self.job.take();
        }
    }
}

#[cfg(unix)]
const SIGKILL: i32 = 9;

#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

#[cfg(windows)]
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
#[cfg(windows)]
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: u32 = 9;

#[cfg(windows)]
struct WinJob {
    handle: *mut std::ffi::c_void,
}

#[cfg(windows)]
unsafe impl Send for WinJob {}

#[cfg(windows)]
impl WinJob {
    fn create_kill_on_close() -> Result<Self, ()> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if handle.is_null() {
                return Err(());
            }
            let mut info = std::mem::zeroed::<JobObjectExtendedLimitInformation>();
            info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                &mut info as *mut _ as *mut _,
                std::mem::size_of_val(&info) as u32,
            );
            if ok == 0 {
                CloseHandle(handle);
                return Err(());
            }
            Ok(Self { handle })
        }
    }

    fn assign_child(&self, child: &Child) -> Result<(), ()> {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            let process = child.as_raw_handle() as *mut std::ffi::c_void;
            if AssignProcessToJobObject(self.handle, process) == 0 {
                return Err(());
            }
        }
        Ok(())
    }

    fn terminate(self, exit_code: u32) {
        unsafe {
            let _ = TerminateJobObject(self.handle, exit_code);
        }
    }
}

#[cfg(windows)]
impl Drop for WinJob {
    fn drop(&mut self) {
        unsafe {
            if !self.handle.is_null() {
                CloseHandle(self.handle);
                self.handle = std::ptr::null_mut();
            }
        }
    }
}

#[cfg(windows)]
#[repr(C)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[cfg(windows)]
#[repr(C)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[cfg(windows)]
#[repr(C)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(
        job_attributes: *mut std::ffi::c_void,
        name: *const u16,
    ) -> *mut std::ffi::c_void;
    fn SetInformationJobObject(
        job: *mut std::ffi::c_void,
        info_class: u32,
        info: *mut std::ffi::c_void,
        length: u32,
    ) -> i32;
    fn AssignProcessToJobObject(
        job: *mut std::ffi::c_void,
        process: *mut std::ffi::c_void,
    ) -> i32;
    fn TerminateJobObject(job: *mut std::ffi::c_void, exit_code: u32) -> i32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}
