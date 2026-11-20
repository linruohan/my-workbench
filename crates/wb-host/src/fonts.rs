use anyhow::Result;

pub fn list_system_fonts() -> Result<Vec<String>> {
    let mut names = Vec::new();
    for family in font_kit::source::SystemSource::new().all_families()? {
        names.push(family);
    }
    names.sort();
    names.dedup();
    Ok(names)
}
