use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;
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

fn bmp_size(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 26 {
        return None;
    }
    let w = i32::from_le_bytes(data[18..22].try_into().ok()?).unsigned_abs();
    let h = i32::from_le_bytes(data[22..26].try_into().ok()?).unsigned_abs();
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h))
}

/// RIFF/WEBP: VP8X canvas, VP8 lossy frame, or VP8L lossless header.
fn webp_size(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 30 || &data[8..12] != b"WEBP" {
        return None;
    }
    let mut i = 12usize;
    while i + 8 <= data.len() {
        let tag = &data[i..i + 4];
        let size = u32::from_le_bytes(data[i + 4..i + 8].try_into().ok()?) as usize;
        let payload = i + 8;
        if tag == b"VP8X" && data.len() >= payload + 10 {
            let w = 1 + u32::from_le_bytes([
                data[payload + 4],
                data[payload + 5],
                data[payload + 6],
                0,
            ]);
            let h = 1 + u32::from_le_bytes([
                data[payload + 7],
                data[payload + 8],
                data[payload + 9],
                0,
            ]);
            return Some((w, h));
        }
        if tag == b"VP8 " && data.len() >= payload + 10 {
            let w = u16::from_le_bytes([data[payload + 6], data[payload + 7]]) as u32 & 0x3fff;
            let h = u16::from_le_bytes([data[payload + 8], data[payload + 9]]) as u32 & 0x3fff;
            return Some((w, h));
        }
        if tag == b"VP8L" && data.len() >= payload + 5 && data[payload] == 0x2f {
            let bits = u32::from_le_bytes(data[payload + 1..payload + 5].try_into().ok()?);
            let w = (bits & 0x3fff) + 1;
            let h = ((bits >> 14) & 0x3fff) + 1;
            return Some((w, h));
        }
        let step = 8 + size + (size % 2);
        if step == 0 {
            break;
        }
        i += step;
    }
    None
}

const VISION_MAX_BYTES: usize = 4 * 1024 * 1024;
const VISION_MAX_EDGE: u32 = 2048;
/// Enough for PNG/GIF/BMP/WebP headers and typical JPEG SOF markers.
const HEADER_READ: usize = 512 * 1024;

/// Inspect an image file (magic + size). Reads a header window, not the whole file.
pub fn read_image_info(path: &Path) -> Result<ImageInfo> {
    let meta =
        std::fs::metadata(path).with_context(|| format!("文件不存在: {}", path.display()))?;
    if !meta.is_file() {
        bail!("不是文件");
    }
    let bytes = usize::try_from(meta.len()).unwrap_or(usize::MAX);
    if bytes == 0 {
        bail!("空文件");
    }
    let mut file = File::open(path).with_context(|| format!("打开失败: {}", path.display()))?;
    let mut data = vec![0u8; HEADER_READ.min(bytes)];
    let n = file.read(&mut data)?;
    data.truncate(n);
    if data.is_empty() {
        bail!("空文件");
    }
    let format = detect_format(&data).to_string();
    let dims = match format.as_str() {
        "png" => png_size(&data),
        "jpeg" => jpeg_size(&data),
        "gif" => gif_size(&data),
        "bmp" => bmp_size(&data),
        "webp" => webp_size(&data),
        _ => None,
    };
    let (width, height) = (dims.map(|(w, _)| w), dims.map(|(_, h)| h));
    let long_edge = width.zip(height).map(|(w, h)| w.max(h)).unwrap_or(0);
    let mut note = String::from("已读取图片元数据");
    if bytes > VISION_MAX_BYTES || long_edge > VISION_MAX_EDGE {
        note.push_str(&format!(
            "\n<image_offload path=\"{}\" bytes={} edge={} limitBytes={} limitEdge={}/> — 体积或边长超 vision 预算，请按需再次 read_image",
            path.display(),
            bytes,
            long_edge,
            VISION_MAX_BYTES,
            VISION_MAX_EDGE
        ));
    }
    Ok(ImageInfo {
        path: path.display().to_string(),
        format,
        bytes,
        width,
        height,
        note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_image_gets_offload_hint() {
        let dir = std::env::temp_dir().join(format!("wb-img-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.bin");
        // Fake oversized JPEG header + padding
        let mut data = vec![0xff, 0xd8, 0xff, 0xe0];
        data.resize(VISION_MAX_BYTES + 10, 0);
        std::fs::write(&path, &data).unwrap();
        let info = read_image_info(&path).unwrap();
        assert!(info.note.contains("image_offload"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bmp_and_webp_report_pixel_size() {
        let mut bmp = vec![0u8; 26];
        bmp[0] = b'B';
        bmp[1] = b'M';
        bmp[18..22].copy_from_slice(&320u32.to_le_bytes());
        bmp[22..26].copy_from_slice(&200u32.to_le_bytes());
        assert_eq!(bmp_size(&bmp), Some((320, 200)));

        let mut webp = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        webp.extend_from_slice(&10u32.to_le_bytes());
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(&[63, 0, 0]);
        webp.extend_from_slice(&[31, 0, 0]);
        assert_eq!(webp_size(&webp), Some((64, 32)));
    }
}
