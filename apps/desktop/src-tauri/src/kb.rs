use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::Path;

const MAX_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
pub fn kb_pick_directory() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("导入知识库目录")
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn kb_list_dir(path: String) -> Result<Vec<KbEntry>, String> {
    let mut out = Vec::new();
    let entries = fs::read_dir(&path).map_err(|err| format!("无法读取目录：{err}"))?;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let file_path = entry.path();
        let is_dir = file_path.is_dir();
        out.push(KbEntry {
            name,
            path: file_path.to_string_lossy().into_owned(),
            is_dir,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub fn kb_read_text(path: String) -> Result<String, String> {
    let bytes = read_limited(&path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn kb_write_text(path: String, contents: String) -> Result<(), String> {
    if contents.len() as u64 > MAX_BYTES {
        return Err("文件过大".into());
    }
    fs::write(&path, contents).map_err(|err| format!("无法写入文件：{err}"))
}

#[tauri::command]
pub fn kb_read_base64(path: String) -> Result<String, String> {
    let bytes = read_limited(&path)?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub fn kb_write_base64(path: String, data: String) -> Result<(), String> {
    let bytes = STANDARD
        .decode(data.trim().as_bytes())
        .map_err(|err| format!("图片数据无效：{err}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("图片过大".into());
    }
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|err| format!("无法创建目录：{err}"))?;
        }
    }
    fs::write(&path, bytes).map_err(|err| format!("无法保存图片：{err}"))
}

#[tauri::command]
pub fn kb_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn kb_mkdir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|err| format!("无法创建目录：{err}"))
}

fn read_limited(path: &str) -> Result<Vec<u8>, String> {
    let meta = fs::metadata(path).map_err(|err| format!("无法读取文件：{err}"))?;
    if meta.len() > MAX_BYTES {
        return Err("文件过大".into());
    }
    fs::read(path).map_err(|err| format!("无法读取文件：{err}"))
}
