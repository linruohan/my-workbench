use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub path: String,
    pub format: String,
    pub bytes: usize,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub note: String,
}

fn detect_format(data: &[u8]) -> &'static str {
    if data.len() >= 8 && data.starts_with(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']) {
        "png"
    } else if data.len() >= 3 && data.starts_with(&[0xff, 0xd8, 0xff]) {
        "jpeg"
    } else if data.len() >= 6 && (data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a")) {
        "gif"
    } else if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        "webp"
    } else if data.len() >= 2 && data.starts_with(b"BM") {
        "bmp"
    } else {
        "unknown"
    }
}

fn png_size(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 24 {
        return None;
    }
    let w = u32::from_be_bytes(data[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(data[20..24].try_into().ok()?);
    Some((w, h))
}

fn jpeg_size(data: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2usize;
    while i + 9 < data.len() {
        if data[i] != 0xff {
            return None;
        }
        let marker = data[i + 1];
        let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
        // SOF0 / SOF2
        if matches!(marker, 0xc0 | 0xc2) && i + 9 < data.len() {
            let h = u16::from_be_bytes([data[i + 5], data[i + 6]]) as u32;
            let w = u16::from_be_bytes([data[i + 7], data[i + 8]]) as u32;
            return Some((w, h));
        }
        if len < 2 {
            return None;
        }
        i += 2 + len;
    }
    None
}

fn gif_size(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 10 {
        return None;
    }
    let w = u16::from_le_bytes([data[6], data[7]]) as u32;
    let h = u16::from_le_bytes([data[8], data[9]]) as u32;
    Some((w, h))
}

/// Inspect an image file (magic + size). No full vision / OCR pipeline yet.
pub fn read_image_info(path: &Path) -> Result<ImageInfo> {
    if !path.exists() {
        bail!("文件不存在");
    }
    let data = fs::read(path)?;
    if data.is_empty() {
        bail!("空文件");
    }
    let format = detect_format(&data).to_string();
    let dims = match format.as_str() {
        "png" => png_size(&data),
        "jpeg" => jpeg_size(&data),
        "gif" => gif_size(&data),
        _ => None,
    };
    Ok(ImageInfo {
        path: path.display().to_string(),
        format,
        bytes: data.len(),
        width: dims.map(|(w, _)| w),
        height: dims.map(|(_, h)| h),
        note: "已读取图片元数据；完整多模态挂载 / OCR 将在后续迭代增强".into(),
    })
}
