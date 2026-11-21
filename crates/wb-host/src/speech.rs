//! Local speech model catalog + status.
//! Transcription prefers the `wb-asr` helper (sherpa-onnx in a separate process),
//! then falls back to `sherpa-onnx-offline` / `sensevoice` CLI.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use wb_store::ensure_data_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechFileSpec {
    pub name: String,
    pub rel_path: String,
    pub url: String,
    pub mirror_url: String,
    pub min_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    pub engine: String,
    pub ready: bool,
    pub model_dir: String,
    pub missing: Vec<String>,
    pub message: Option<String>,
}

pub fn sensevoice_files() -> Vec<SpeechFileSpec> {
    vec![
        SpeechFileSpec {
            name: "model.int8.onnx".into(),
            rel_path: "sensevoice-onnx/model.int8.onnx".into(),
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx".into(),
            mirror_url: "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx".into(),
            min_bytes: 200_000_000,
        },
        SpeechFileSpec {
            name: "tokens.txt".into(),
            rel_path: "sensevoice-onnx/tokens.txt".into(),
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt".into(),
            mirror_url: "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt".into(),
            min_bytes: 100_000,
        },
        SpeechFileSpec {
            name: "silero_vad.onnx".into(),
            rel_path: "silero/silero_vad.onnx".into(),
            url: "https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx".into(),
            mirror_url: "https://hf-mirror.com/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx".into(),
            min_bytes: 1_000_000,
        },
    ]
}

pub fn speech_model_dir(engine: &str) -> Result<PathBuf> {
    Ok(ensure_data_dir()?.join("models").join(engine))
}

fn file_ready(path: &Path, min_bytes: u64) -> bool {
    fs::metadata(path)
        .map(|m| m.len() >= min_bytes)
        .unwrap_or(false)
}

pub fn speech_status(engine: &str) -> Result<SpeechStatus> {
    let dir = speech_model_dir(engine)?;
    let files = if engine.eq_ignore_ascii_case("sensevoice") {
        sensevoice_files()
    } else {
        Vec::new()
    };
    let missing: Vec<_> = if files.is_empty() {
        if dir.exists()
            && fs::read_dir(&dir)
                .map(|mut d| d.next().is_some())
                .unwrap_or(false)
        {
            Vec::new()
        } else {
            vec!["（未配置该引擎文件清单）".into()]
        }
    } else {
        files
            .into_iter()
            .filter(|f| !file_ready(&dir.join(&f.rel_path), f.min_bytes))
            .map(|f| f.name)
            .collect()
    };
    let ready = missing.is_empty();
    let has_worker = find_wb_asr().is_some()
        || crate::shell::which_bin("sherpa-onnx-offline").is_some()
        || crate::shell::which_bin("sensevoice").is_some();
    Ok(SpeechStatus {
        engine: engine.into(),
        ready,
        model_dir: dir.to_string_lossy().to_string(),
        missing: missing.clone(),
        message: if ready && has_worker {
            Some("SenseVoice 模型已就绪（wb-asr / sherpa CLI）".into())
        } else if ready {
            Some("SenseVoice 模型已就绪；请构建/安装 wb-asr，或安装 sherpa-onnx-offline CLI".into())
        } else {
            Some(format!(
                "模型尚未就绪，缺少 {} 个文件。可在设置中准备/下载。",
                missing.len()
            ))
        },
    })
}

/// Create dirs and optionally download SenseVoice files (tokens/vad first; large onnx last).
pub fn speech_ensure_models(engine: &str) -> Result<SpeechStatus> {
    speech_ensure_models_ex(engine, false)
}

pub fn speech_ensure_models_ex(engine: &str, download: bool) -> Result<SpeechStatus> {
    let dir = speech_model_dir(engine)?;
    fs::create_dir_all(&dir).context("创建模型目录失败")?;
    if download && engine.eq_ignore_ascii_case("sensevoice") {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()?;
        // Download smaller files first so status improves quickly.
        let mut files = sensevoice_files();
        files.sort_by_key(|f| f.min_bytes);
        for file in files {
            let path = dir.join(&file.rel_path);
            if file_ready(&path, file.min_bytes) {
                continue;
            }
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            if let Err(e) = download_file(&client, &file.mirror_url, &path, file.min_bytes) {
                log::warn!("mirror download failed for {}: {e}", file.name);
                download_file(&client, &file.url, &path, file.min_bytes)?;
            }
        }
    }
    speech_status(engine)
}

fn download_file(
    client: &reqwest::blocking::Client,
    url: &str,
    path: &Path,
    min_bytes: u64,
) -> Result<()> {
    let resp = client.get(url).send().context("下载语音模型失败")?;
    if !resp.status().is_success() {
        bail!("下载失败 HTTP {}", resp.status());
    }
    let bytes = resp.bytes().context("读取下载内容失败")?;
    if (bytes.len() as u64) < min_bytes {
        bail!(
            "下载文件过小：{} < {}（可能是错误页）",
            bytes.len(),
            min_bytes
        );
    }
    let tmp = path.with_extension("part");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn speech_warm(engine: &str) -> Result<SpeechStatus> {
    speech_status(engine)
}

fn find_wb_asr() -> Option<PathBuf> {
    if let Some(p) = crate::shell::which_bin("wb-asr") {
        return Some(PathBuf::from(p));
    }
    let exe_name = if cfg!(windows) {
        "wb-asr.exe"
    } else {
        "wb-asr"
    };
    if let Ok(current) = std::env::current_exe()
        && let Some(dir) = current.parent()
    {
        let sibling = dir.join(exe_name);
        if sibling.is_file() {
            return Some(sibling);
        }
        // cargo run: target/debug/wb-app.exe → look for target/debug/wb-asr.exe
        // also try ../ if nested
        for up in [dir.to_path_buf(), dir.join(".."), dir.join("../..")] {
            for profile in ["debug", "release"] {
                let cand = up.join(profile).join(exe_name);
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
    }
    None
}

fn run_wb_asr(bin: &Path, model_dir: &str, wav_path: &str, language: &str) -> Result<String> {
    let tokens = Path::new(model_dir).join("sensevoice-onnx/tokens.txt");
    let model = Path::new(model_dir).join("sensevoice-onnx/model.int8.onnx");
    let out = Command::new(bin)
        .arg("--tokens")
        .arg(&tokens)
        .arg("--model")
        .arg(&model)
        .arg("--language")
        .arg(language)
        .arg(wav_path)
        .output()
        .context("启动 wb-asr 失败")?;
    if out.status.success() {
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !text.is_empty() {
            return Ok(text);
        }
    }
    let err = String::from_utf8_lossy(&out.stderr);
    bail!("wb-asr 失败：{err}")
}

fn run_sherpa_cli(model_dir: &str, wav_path: &str, language: &str) -> Option<Result<String>> {
    let bin = crate::shell::which_bin("sherpa-onnx-offline")
        .or_else(|| crate::shell::which_bin("sensevoice"))?;
    let tokens = Path::new(model_dir).join("sensevoice-onnx/tokens.txt");
    let model = Path::new(model_dir).join("sensevoice-onnx/model.int8.onnx");
    let mut cmd = Command::new(&bin);
    cmd.arg("--tokens")
        .arg(&tokens)
        .arg("--sense-voice-model")
        .arg(&model)
        .arg("--language")
        .arg(language)
        .arg(wav_path);
    let out = match cmd.output() {
        Ok(o) => o,
        Err(e) => return Some(Err(e).context("启动语音 CLI 失败")),
    };
    if out.status.success() {
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !text.is_empty() {
            return Some(Ok(text));
        }
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Some(Err(anyhow::anyhow!("语音 CLI 失败：{err}")))
}

/// Transcribe a WAV file via `wb-asr` helper, then sherpa CLI fallback.
pub fn speech_transcribe(engine: &str, wav_path: &str, language: Option<&str>) -> Result<String> {
    let wav = Path::new(wav_path);
    if !wav.is_file() {
        bail!("录音文件不存在：{wav_path}");
    }
    let status = speech_status(engine)?;
    let lang = language.unwrap_or("auto");

    if status.ready
        && let Some(bin) = find_wb_asr()
    {
        match run_wb_asr(&bin, &status.model_dir, wav_path, lang) {
            Ok(text) => return Ok(text),
            Err(e) => log::warn!("wb-asr failed: {e}"),
        }
    }

    if let Some(result) = run_sherpa_cli(&status.model_dir, wav_path, lang) {
        return result;
    }

    if !status.ready {
        bail!(
            "语音模型未就绪（{}）。请在设置中下载 SenseVoice，并构建 wb-asr 或安装 sherpa-onnx-offline。",
            status.message.unwrap_or_else(|| status.model_dir.clone())
        );
    }
    bail!(
        "SenseVoice 模型已在 {}，但未找到 wb-asr / sherpa-onnx-offline / sensevoice。请 `cargo build -p wb-asr`。",
        status.model_dir
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensevoice_catalog() {
        assert_eq!(sensevoice_files().len(), 3);
    }
}
