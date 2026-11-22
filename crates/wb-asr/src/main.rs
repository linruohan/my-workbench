//! Standalone SenseVoice worker. Kept separate from wb-host/wb-app so
//! sherpa-onnx's Windows MT CRT does not collide with paddle-ocr clipper (MD).
//!
//! One-shot: `wb-asr --model <onnx> --tokens <txt> [--language auto] <wav>`
//! Resident: `wb-asr --model <onnx> --tokens <txt> [--language auto] --serve`
//!   loads the model once, writes `READY`, then reads wav paths from stdin.
//!   Each reply is one line: `+<text>` or `-<error>`.

use anyhow::{Context, Result, bail};
use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig, Wave};
use std::env;
use std::io::{BufRead, Write};
use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    match run() {
        Ok(Outcome::Text(text)) => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        Ok(Outcome::Served) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("wb-asr: {e:#}");
            ExitCode::FAILURE
        }
    }
}

enum Outcome {
    Text(String),
    Served,
}

fn run() -> Result<Outcome> {
    let mut model = None::<String>;
    let mut tokens = None::<String>;
    let mut language = "auto".to_string();
    let mut wav = None::<String>;
    let mut serve = false;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--model" => {
                model = Some(args.next().context("--model 需要路径")?);
            }
            "--tokens" => {
                tokens = Some(args.next().context("--tokens 需要路径")?);
            }
            "--language" => {
                language = args.next().context("--language 需要值")?;
            }
            "--serve" => serve = true,
            "-h" | "--help" => {
                eprintln!(
                    "usage: wb-asr --model <onnx> --tokens <txt> [--language auto] [--serve] [wav]"
                );
                bail!("help");
            }
            other if other.starts_with('-') => bail!("未知参数：{other}"),
            other => {
                if wav.is_some() {
                    bail!("多余参数：{other}");
                }
                wav = Some(other.to_string());
            }
        }
    }

    let model = model.context("缺少 --model")?;
    let tokens = tokens.context("缺少 --tokens")?;
    if !Path::new(&model).is_file() {
        bail!("模型不存在：{model}");
    }
    if !Path::new(&tokens).is_file() {
        bail!("tokens 不存在：{tokens}");
    }

    let recognizer = load_recognizer(model, tokens, language)?;
    if serve {
        serve_loop(&recognizer)?;
        return Ok(Outcome::Served);
    }

    let wav = wav.context("缺少 wav 路径")?;
    let text = decode(&recognizer, &wav)?;
    if text.is_empty() {
        bail!("未识别到语音内容");
    }
    Ok(Outcome::Text(text))
}

fn load_recognizer(model: String, tokens: String, language: String) -> Result<OfflineRecognizer> {
    let mut config = OfflineRecognizerConfig::default();
    // SenseVoice is small; a handful of threads covers inference without
    // taking the whole machine away from the UI.
    config.model_config.num_threads = inference_threads();
    config.model_config.debug = false;
    config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
        model: Some(model),
        language: Some(language),
        use_itn: true,
    };
    config.model_config.tokens = Some(tokens);
    OfflineRecognizer::create(&config).context("创建 SenseVoice 识别器失败")
}

fn inference_threads() -> i32 {
    let cores = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1);
    cores.clamp(1, 4) as i32
}

fn decode(recognizer: &OfflineRecognizer, wav: &str) -> Result<String> {
    if !Path::new(wav).is_file() {
        bail!("录音不存在：{wav}");
    }
    let wave = Wave::read(wav).with_context(|| format!("读取 WAV 失败：{wav}"))?;
    let stream = recognizer.create_stream();
    stream.accept_waveform(wave.sample_rate(), wave.samples());
    recognizer.decode(&stream);
    Ok(stream
        .get_result()
        .map(|result| result.text.trim().to_string())
        .unwrap_or_default())
}

/// Model stays loaded. Stdout is the protocol, so logs must stay on stderr.
fn serve_loop(recognizer: &OfflineRecognizer) -> Result<()> {
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    writeln!(out, "READY")?;
    out.flush()?;

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = line.context("读取转写请求失败")?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line == "QUIT" {
            break;
        }
        let reply = match decode(recognizer, line) {
            Ok(text) => format!("+{}", one_line(&text)),
            Err(err) => format!("-{}", one_line(&format!("{err:#}"))),
        };
        writeln!(out, "{reply}")?;
        out.flush()?;
    }
    Ok(())
}

fn one_line(text: &str) -> String {
    text.replace(['\r', '\n'], " ")
}

#[cfg(test)]
mod tests {
    use super::one_line;

    #[test]
    fn reply_text_stays_on_one_line() {
        assert_eq!(one_line("你好\n世界\r\n"), "你好 世界  ");
    }
}
