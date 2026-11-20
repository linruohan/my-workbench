use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use wb_store::ensure_data_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    pub engine: String,
    pub ready: bool,
    pub model_dir: String,
    pub message: Option<String>,
}

pub fn speech_model_dir(engine: &str) -> Result<PathBuf> {
    Ok(ensure_data_dir()?.join("models").join(engine))
}

pub fn speech_status(engine: &str) -> Result<SpeechStatus> {
    let dir = speech_model_dir(engine)?;
    let ready = dir.exists()
        && fs::read_dir(&dir)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false);
    Ok(SpeechStatus {
        engine: engine.into(),
        ready,
        model_dir: dir.to_string_lossy().to_string(),
        message: if ready {
            None
        } else {
            Some("模型尚未下载，请在设置中准备语音引擎".into())
        },
    })
}

/// Placeholder: full ASR wiring lands with bundled worker scripts.
pub fn speech_transcribe(
    _engine: &str,
    _wav_path: &str,
    _language: Option<&str>,
) -> Result<String> {
    bail!("语音转写需先下载本地模型；当前为 Rust 宿主占位实现")
}

pub fn speech_ensure_models(engine: &str) -> Result<SpeechStatus> {
    let dir = speech_model_dir(engine)?;
    fs::create_dir_all(&dir).context("创建模型目录失败")?;
    speech_status(engine)
}

pub fn speech_warm(engine: &str) -> Result<SpeechStatus> {
    speech_status(engine)
}
