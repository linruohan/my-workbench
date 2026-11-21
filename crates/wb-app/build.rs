//! Rasterize `data/icons/app.svg` and, on Windows, embed it as icon resource 1.
//!
//! GPUI loads the window icon with `LoadImageW` of resource id 1. The tray uses
//! the same resource.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

const SIZES: [u32; 7] = [16, 24, 32, 48, 64, 128, 256];

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let svg_path = manifest_dir.join("../../data/icons/app.svg");
    println!("cargo:rerun-if-changed={}", svg_path.display());
    println!("cargo:rerun-if-changed=build.rs");

    let svg = std::fs::read_to_string(&svg_path)
        .unwrap_or_else(|err| panic!("读取图标 {} 失败: {err}", svg_path.display()));

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let ico_path = out_dir.join("app.ico");
    let ico = encode_ico(&svg);
    std::fs::write(&ico_path, &ico)
        .unwrap_or_else(|err| panic!("写入 {} 失败: {err}", ico_path.display()));

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_windows_icon(&out_dir, &ico_path);
    }
}

fn encode_ico(svg: &str) -> Vec<u8> {
    let options = resvg::usvg::Options::default();
    let tree = resvg::usvg::Tree::from_str(svg, &options).expect("解析 app.svg 失败");
    let images: Vec<(u32, Vec<u8>)> = SIZES
        .into_iter()
        .map(|size| (size, encode_bmp32(size, &rasterize(&tree, size))))
        .collect();

    let mut cursor = 6 + 16 * images.len() as u32;
    let mut header = Vec::with_capacity(cursor as usize);
    header.extend_from_slice(&0u16.to_le_bytes());
    header.extend_from_slice(&1u16.to_le_bytes());
    header.extend_from_slice(&(images.len() as u16).to_le_bytes());
    for (size, bmp) in &images {
        let dim = if *size >= 256 { 0 } else { *size as u8 };
        header.push(dim);
        header.push(dim);
        header.push(0);
        header.push(0);
        header.extend_from_slice(&1u16.to_le_bytes());
        header.extend_from_slice(&32u16.to_le_bytes());
        header.extend_from_slice(&(bmp.len() as u32).to_le_bytes());
        header.extend_from_slice(&cursor.to_le_bytes());
        cursor += bmp.len() as u32;
    }
    for (_, bmp) in &images {
        header.extend_from_slice(bmp);
    }
    header
}

fn rasterize(tree: &resvg::usvg::Tree, size: u32) -> Vec<u8> {
    let svg_size = tree.size();
    let transform = resvg::tiny_skia::Transform::from_scale(
        size as f32 / svg_size.width(),
        size as f32 / svg_size.height(),
    );
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size, size)
        .unwrap_or_else(|| panic!("无法创建 {size}px 图标画布"));
    resvg::render(tree, transform, &mut pixmap.as_mut());
    unpremultiply(pixmap.data())
}

fn unpremultiply(data: &[u8]) -> Vec<u8> {
    let mut out = data.to_vec();
    for pixel in out.chunks_exact_mut(4) {
        let alpha = u32::from(pixel[3]);
        if alpha == 0 {
            pixel[0] = 0;
            pixel[1] = 0;
            pixel[2] = 0;
        } else if alpha < 255 {
            pixel[0] = ((u32::from(pixel[0]) * 255) / alpha).min(255) as u8;
            pixel[1] = ((u32::from(pixel[1]) * 255) / alpha).min(255) as u8;
            pixel[2] = ((u32::from(pixel[2]) * 255) / alpha).min(255) as u8;
        }
    }
    out
}

/// 32-bit BMP payload stored inside an ICO (no file header). Rows are bottom-up.
fn encode_bmp32(size: u32, rgba: &[u8]) -> Vec<u8> {
    let width = size as usize;
    let height = size as usize;
    let mask_row_data = width.div_ceil(8);
    let mask_row_size = mask_row_data.div_ceil(4) * 4;
    let mut data = Vec::with_capacity(40 + width * height * 4 + height * mask_row_size);
    data.extend_from_slice(&40u32.to_le_bytes());
    data.extend_from_slice(&(width as i32).to_le_bytes());
    data.extend_from_slice(&((height as i32) * 2).to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&32u16.to_le_bytes());
    data.extend_from_slice(&[0u8; 24]);
    assert_eq!(data.len(), 40);
    for row in 0..height {
        let start = 4 * (height - 1 - row) * width;
        for col in 0..width {
            let index = start + col * 4;
            data.push(rgba[index + 2]);
            data.push(rgba[index + 1]);
            data.push(rgba[index]);
            data.push(rgba[index + 3]);
        }
    }
    for row in 0..height {
        let start = 4 * (height - 1 - row) * width;
        let mut col = 0;
        for _ in 0..mask_row_data {
            let mut byte = 0u8;
            for bit in 0..8 {
                if col < width {
                    if rgba[start + col * 4 + 3] == 0 {
                        byte |= 1 << (7 - bit);
                    }
                    col += 1;
                }
            }
            data.push(byte);
        }
        data.resize(data.len() + mask_row_size - mask_row_data, 0);
    }
    data
}

fn embed_windows_icon(out_dir: &Path, ico_path: &Path) {
    let rc_path = out_dir.join("app_icon.rc");
    let ico_for_rc = ico_path.to_string_lossy().replace('\\', "/");
    let mut rc = File::create(&rc_path).expect("创建 app_icon.rc 失败");
    writeln!(rc, "1 ICON \"{ico_for_rc}\"").expect("写入 app_icon.rc 失败");
    embed_resource::compile(&rc_path, embed_resource::NONE)
        .manifest_required()
        .unwrap_or_else(|err| panic!("嵌入应用图标失败: {err}"));
}
