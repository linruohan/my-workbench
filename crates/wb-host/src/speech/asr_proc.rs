//! Resident `wb-asr` process.
//!
//! Loading SenseVoice dominates dictation latency, so the recognizer stays up
//! for the whole time voice input is enabled. A one-shot process remains the
//! fallback when this `wb-asr` build has no `--serve` mode.

use anyhow::{Context, Result, anyhow};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(60);
const RESULT_TIMEOUT: Duration = Duration::from_secs(90);

static SERVE_UNSUPPORTED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, PartialEq, Eq)]
struct WorkerKey {
    bin: PathBuf,
    model: PathBuf,
    tokens: PathBuf,
    language: String,
}

impl WorkerKey {
    fn new(bin: &Path, model_dir: &str, language: &str) -> Result<Self> {
        let root = Path::new(model_dir);
        let model = root.join("sensevoice-onnx/model.int8.onnx");
        let tokens = root.join("sensevoice-onnx/tokens.txt");
        if !model.is_file() || !tokens.is_file() {
            anyhow::bail!("SenseVoice 模型文件不完整");
        }
        let language = language.trim();
        let language = if language.is_empty() {
            "auto"
        } else {
            language
        };
        Ok(Self {
            bin: bin.to_path_buf(),
            model,
            tokens,
            language: language.to_string(),
        })
    }
}

struct Worker {
    key: WorkerKey,
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Debug)]
enum AskFail {
    /// The process answered; do not start a second recognizer for this clip.
    Recognize(anyhow::Error),
    /// The resident process did not answer. The caller may fall back.
    Process(anyhow::Error),
}

pub(super) struct AsrReply {
    pub text: Result<String>,
    /// `true` when a one-shot `wb-asr` (or another backend) should try.
    pub fallback: bool,
}

fn slot() -> &'static Mutex<Option<Worker>> {
    static SLOT: OnceLock<Mutex<Option<Worker>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn serve_unsupported() -> bool {
    SERVE_UNSUPPORTED.load(Ordering::SeqCst)
}

fn mark_unsupported() {
    SERVE_UNSUPPORTED.store(true, Ordering::SeqCst);
}

/// Drop the resident process so a model swap can delete its files.
pub(super) fn shutdown() {
    if let Ok(mut guard) = slot().lock() {
        *guard = None;
    }
}

/// Load the model now, so the first release does not pay for process startup.
pub(super) fn warm(bin: &Path, model_dir: &str, language: &str) -> Result<()> {
    if serve_unsupported() {
        anyhow::bail!("wb-asr 不支持常驻模式，请重新构建 wb-asr");
    }
    let key = WorkerKey::new(bin, model_dir, language)?;
    let mut guard = slot().lock().map_err(|_| anyhow!("语音引擎锁损坏"))?;
    ensure_worker(&mut guard, &key)
}

pub(super) fn transcribe(bin: &Path, model_dir: &str, wav_path: &str, language: &str) -> AsrReply {
    if serve_unsupported() {
        return process_reply(anyhow!("wb-asr 不支持常驻模式"));
    }
    let key = match WorkerKey::new(bin, model_dir, language) {
        Ok(key) => key,
        Err(err) => {
            return AsrReply {
                text: Err(err),
                fallback: false,
            };
        }
    };
    let Ok(mut guard) = slot().lock() else {
        return process_reply(anyhow!("语音引擎锁损坏"));
    };
    match dispatch(&mut guard, &key, wav_path) {
        Ok(text) => AsrReply {
            text: Ok(text),
            fallback: false,
        },
        Err(AskFail::Recognize(err)) => AsrReply {
            text: Err(err),
            fallback: false,
        },
        Err(AskFail::Process(err)) => {
            *guard = None;
            if serve_unsupported() {
                return AsrReply {
                    text: Err(err),
                    fallback: true,
                };
            }
            match dispatch(&mut guard, &key, wav_path) {
                Ok(text) => AsrReply {
                    text: Ok(text),
                    fallback: false,
                },
                Err(AskFail::Recognize(err)) => AsrReply {
                    text: Err(err),
                    fallback: false,
                },
                Err(AskFail::Process(err)) => AsrReply {
                    text: Err(err),
                    fallback: true,
                },
            }
        }
    }
}

fn process_reply(err: anyhow::Error) -> AsrReply {
    AsrReply {
        text: Err(err),
        fallback: true,
    }
}

fn dispatch(slot: &mut Option<Worker>, key: &WorkerKey, wav: &str) -> Result<String, AskFail> {
    ensure_worker(slot, key).map_err(AskFail::Process)?;
    let worker = slot.as_mut().expect("worker was just ensured");
    ask(worker, wav)
}

fn ensure_worker(slot: &mut Option<Worker>, key: &WorkerKey) -> Result<()> {
    if let Some(worker) = slot.as_mut()
        && worker.key == *key
        && matches!(worker.child.try_wait(), Ok(None))
    {
        return Ok(());
    }
    *slot = None;
    *slot = Some(spawn_worker(key)?);
    Ok(())
}

fn spawn_worker(key: &WorkerKey) -> Result<Worker> {
    if serve_unsupported() {
        anyhow::bail!("wb-asr 不支持常驻模式，请重新构建 wb-asr");
    }
    let mut cmd = Command::new(&key.bin);
    cmd.arg("--model")
        .arg(&key.model)
        .arg("--tokens")
        .arg(&key.tokens)
        .arg("--language")
        .arg(&key.language)
        .arg("--serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().context("启动 wb-asr 失败")?;
    let stdout = child.stdout.take().context("wb-asr stdout")?;
    let stderr = child.stderr.take();
    let stdin = child.stdin.take().context("wb-asr stdin")?;
    let notes = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = stderr {
        let notes = notes.clone();
        let _ = thread::Builder::new()
            .name("wb-asr-err".into())
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    log::warn!("wb-asr: {line}");
                    if let Ok(mut buf) = notes.lock()
                        && buf.len() < 4_000
                    {
                        buf.push_str(&line);
                        buf.push('\n');
                    }
                }
            });
    }
    let (tx, rx) = mpsc::channel();
    let _ = thread::Builder::new()
        .name("wb-asr-out".into())
        .spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });

    if let Err(err) = wait_ready(&rx) {
        let _ = child.kill();
        let _ = child.wait();
        // The stderr thread exits once the pipe closes. Give it a moment to
        // append the line that explains a missing `--serve` flag.
        thread::sleep(Duration::from_millis(30));
        let extra = notes
            .lock()
            .ok()
            .map(|buf| buf.trim().to_string())
            .unwrap_or_default();
        if extra.contains("未知参数") {
            mark_unsupported();
            anyhow::bail!("wb-asr 不支持常驻模式，请重新构建 wb-asr");
        }
        if extra.is_empty() {
            return Err(err);
        }
        anyhow::bail!("{err:#}：{extra}");
    }

    Ok(Worker {
        key: key.clone(),
        child,
        stdin,
        lines: rx,
    })
}

fn wait_ready(lines: &Receiver<String>) -> Result<()> {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            anyhow::bail!("wb-asr 加载模型超时");
        }
        match lines.recv_timeout(left) {
            Ok(line) if line.trim() == "READY" => return Ok(()),
            Ok(line) => log::info!("wb-asr: {line}"),
            Err(mpsc::RecvTimeoutError::Timeout) => anyhow::bail!("wb-asr 加载模型超时"),
            Err(mpsc::RecvTimeoutError::Disconnected) => anyhow::bail!("wb-asr 在就绪前退出"),
        }
    }
}

fn ask(worker: &mut Worker, wav: &str) -> Result<String, AskFail> {
    if wav.chars().any(|ch| ch == '\n' || ch == '\r') {
        return Err(AskFail::Recognize(anyhow!("录音路径无效")));
    }
    writeln!(worker.stdin, "{wav}").map_err(|err| AskFail::Process(anyhow!(err)))?;
    worker
        .stdin
        .flush()
        .map_err(|err| AskFail::Process(anyhow!(err)))?;
    match worker.lines.recv_timeout(RESULT_TIMEOUT) {
        Ok(line) => parse_asr_line(&line),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(AskFail::Process(anyhow!("wb-asr 转写超时"))),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(AskFail::Process(anyhow!("wb-asr 已退出")))
        }
    }
}

fn parse_asr_line(line: &str) -> Result<String, AskFail> {
    let line = line.trim();
    if let Some(text) = line.strip_prefix('+') {
        return Ok(text.trim().to_string());
    }
    if let Some(err) = line.strip_prefix('-') {
        let err = err.trim();
        let err = if err.is_empty() {
            "语音转写失败"
        } else {
            err
        };
        return Err(AskFail::Recognize(anyhow!(err.to_string())));
    }
    Err(AskFail::Process(anyhow!(
        "wb-asr 返回了无法识别的内容：{line}"
    )))
}

#[cfg(test)]
mod tests {
    use super::{AskFail, parse_asr_line};

    #[test]
    fn protocol_separates_text_from_errors() {
        assert_eq!(parse_asr_line("+你好").unwrap(), "你好");
        assert_eq!(parse_asr_line("+\n").unwrap(), "");
        match parse_asr_line("-录音不存在") {
            Err(AskFail::Recognize(err)) => assert!(err.to_string().contains("录音不存在")),
            other => panic!("expected a recognition error, got {other:?}"),
        }
        assert!(matches!(parse_asr_line("READY"), Err(AskFail::Process(_))));
    }
}
