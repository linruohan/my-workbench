//! Local OCR model catalog (PaddleOCR) and optional tesseract fallback.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use wb_store::ensure_data_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrFileSpec {
    pub name: String,
    pub url: String,
    pub min_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrStatus {
    pub ready: bool,
    pub model_dir: String,
    pub missing: Vec<String>,
    pub message: Option<String>,
}

pub fn paddleocr_files() -> Vec<OcrFileSpec> {
    vec![
        OcrFileSpec {
            name: "PP-OCRv6_det_small.onnx".into(),
            url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx".into(),
            min_bytes: 800_000,
        },
        OcrFileSpec {
            name: "PP-OCRv6_rec_small.onnx".into(),
            url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx".into(),
            min_bytes: 2_000_000,
        },
        OcrFileSpec {
            name: "ppocrv6_dict.txt".into(),
            url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt".into(),
            min_bytes: 10_000,
        },
    ]
}

pub fn ocr_model_dir() -> Result<PathBuf> {
    Ok(ensure_data_dir()?.join("models").join("paddleocr"))
}

fn file_ready(path: &Path, min_bytes: u64) -> bool {
    fs::metadata(path)
        .map(|m| m.len() >= min_bytes)
        .unwrap_or(false)
}

pub fn ocr_status() -> Result<OcrStatus> {
    let dir = ocr_model_dir()?;
    let missing: Vec<_> = paddleocr_files()
        .into_iter()
        .filter(|f| !file_ready(&dir.join(&f.name), f.min_bytes))
        .map(|f| f.name)
        .collect();
    let ready = missing.is_empty() && dir.is_dir();
    Ok(OcrStatus {
        ready,
        model_dir: dir.to_string_lossy().to_string(),
        missing: missing.clone(),
        message: if ready {
            Some("PaddleOCR 模型已就绪（运行时可用 tesseract 回退）".into())
        } else {
            Some(format!("缺少 {} 个模型文件", missing.len()))
        },
    })
}

pub fn ocr_ensure_models(download: bool) -> Result<OcrStatus> {
    let dir = ocr_model_dir()?;
    fs::create_dir_all(&dir).context("创建 OCR 模型目录失败")?;
    if download {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()?;
        for file in paddleocr_files() {
            let path = dir.join(&file.name);
            if file_ready(&path, file.min_bytes) {
                continue;
            }
            download_file(&client, &file.url, &path, file.min_bytes)?;
        }
    }
    ocr_status()
}

fn download_file(
    client: &reqwest::blocking::Client,
    url: &str,
    path: &Path,
    min_bytes: u64,
) -> Result<()> {
    let resp = client.get(url).send().context("下载 OCR 模型失败")?;
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
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Prefer tesseract / RapidOCR Python / paddleocr CLI; otherwise report model readiness.
pub fn ocr_image(path: &Path) -> Result<String> {
    if !path.is_file() {
        bail!("图片不存在：{}", path.display());
    }
    if let Some(text) = try_tesseract(path) {
        return Ok(text);
    }
    if let Some(text) = try_python_rapidocr(path) {
        return Ok(text);
    }
    if let Some(text) = try_paddleocr_cli(path) {
        return Ok(text);
    }
    let status = ocr_status()?;
    if status.ready {
        bail!(
            "PaddleOCR 模型已在 {}，但未找到 tesseract / rapidocr_onnxruntime / paddleocr CLI，且尚未接入内置 ONNX 运行时。",
            status.model_dir
        );
    }
    bail!(
        "OCR 未就绪：缺少 {:?}。可在设置中下载 PaddleOCR 模型，或安装 tesseract / pip install rapidocr-onnxruntime。",
        status.missing
    )
}

fn try_tesseract(path: &Path) -> Option<String> {
    crate::shell::which_bin("tesseract")?;
    let out = Command::new("tesseract")
        .args([
            path.to_string_lossy().as_ref(),
            "stdout",
            "-l",
            "chi_sim+eng",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Some(if text.is_empty() {
        "没有识别到文字。".into()
    } else {
        text
    })
}

fn try_python_rapidocr(path: &Path) -> Option<String> {
    let py = crate::shell::which_bin("python").or_else(|| crate::shell::which_bin("python3"))?;
    let script = r#"
import sys
path = sys.argv[1]
try:
    from rapidocr_onnxruntime import RapidOCR
except Exception:
    try:
        from rapidocr_onnxruntime.main import RapidOCR
    except Exception as e:
        print(e, file=sys.stderr)
        sys.exit(2)
ocr = RapidOCR()
result, _ = ocr(path)
if not result:
    print("")
else:
    print("\n".join(str(item[1]) for item in result))
"#;
    let out = Command::new(&py)
        .args(["-c", script, path.to_string_lossy().as_ref()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Some(if text.is_empty() {
        "没有识别到文字。".into()
    } else {
        text
    })
}

fn try_paddleocr_cli(path: &Path) -> Option<String> {
    let bin = crate::shell::which_bin("paddleocr")?;
    let out = Command::new(&bin)
        .args([
            "ocr",
            "-i",
            path.to_string_lossy().as_ref(),
            "--use_angle_cls",
            "true",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_three_files() {
        assert_eq!(paddleocr_files().len(), 3);
    }
}
