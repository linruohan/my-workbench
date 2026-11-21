//! Standalone SenseVoice worker. Kept separate from wb-host/wb-app so
//! sherpa-onnx's Windows MT CRT does not collide with paddle-ocr clipper (MD).

use anyhow::{Context, Result, bail};
use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig, Wave};
use std::env;
use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    match run() {
        Ok(text) => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("wb-asr: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<String> {
    let mut model = None::<String>;
    let mut tokens = None::<String>;
    let mut language = "auto".to_string();
    let mut wav = None::<String>;

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
            "-h" | "--help" => {
                eprintln!("usage: wb-asr --model <onnx> --tokens <txt> [--language auto] <wav>");
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
    let wav = wav.context("缺少 wav 路径")?;

    if !Path::new(&model).is_file() {
        bail!("模型不存在：{model}");
    }
    if !Path::new(&tokens).is_file() {
        bail!("tokens 不存在：{tokens}");
    }
    if !Path::new(&wav).is_file() {
        bail!("录音不存在：{wav}");
    }

    let wave = Wave::read(&wav).with_context(|| format!("读取 WAV 失败：{wav}"))?;

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
        model: Some(model),
        language: Some(language),
        use_itn: true,
    };
    config.model_config.tokens = Some(tokens);

    let recognizer = OfflineRecognizer::create(&config).context("创建 SenseVoice 识别器失败")?;
    let stream = recognizer.create_stream();
    stream.accept_waveform(wave.sample_rate(), wave.samples());
    recognizer.decode(&stream);
    let text = stream
        .get_result()
        .map(|r| r.text.trim().to_string())
        .unwrap_or_default();
    if text.is_empty() {
        bail!("未识别到语音内容");
    }
    Ok(text)
}
