use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use wb_domain::{BUILTIN_MODEL_REF, BUILTIN_PROVIDER_ID, ProviderConfig, ProviderKind};
use wb_store::{CREDENTIALS_FILE, data_file_path};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStore {
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    #[serde(default)]
    pub default_model_ref: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CredentialStore {
    #[serde(default)]
    pub keys: HashMap<String, String>,
}

pub fn default_providers() -> ProviderStore {
    ProviderStore {
        providers: vec![
            ProviderConfig {
                id: BUILTIN_PROVIDER_ID.into(),
                name: "内置".into(),
                kind: ProviderKind::Builtin,
                base_url: String::new(),
                api_key_required: false,
                enabled: true,
                models: serde_json::Map::new(),
            },
            ProviderConfig {
                id: "ollama".into(),
                name: "Ollama".into(),
                kind: ProviderKind::OpenaiChatCompletions,
                base_url: "http://127.0.0.1:11434/v1".into(),
                api_key_required: false,
                enabled: true,
                models: serde_json::Map::new(),
            },
            ProviderConfig {
                id: "openai".into(),
                name: "OpenAI".into(),
                kind: ProviderKind::OpenaiChatCompletions,
                base_url: "https://api.openai.com/v1".into(),
                api_key_required: true,
                enabled: true,
                models: serde_json::Map::new(),
            },
            ProviderConfig {
                id: "deepseek".into(),
                name: "DeepSeek".into(),
                kind: ProviderKind::OpenaiChatCompletions,
                base_url: "https://api.deepseek.com/v1".into(),
                api_key_required: true,
                enabled: true,
                models: serde_json::Map::new(),
            },
        ],
        default_model_ref: Some(BUILTIN_MODEL_REF.into()),
    }
}

pub fn load_providers() -> ProviderStore {
    let path = match data_file_path("providers.json") {
        Ok(p) => p,
        Err(_) => return default_providers(),
    };
    if !path.exists() {
        return default_providers();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(default_providers)
}

pub fn save_providers(store: &ProviderStore) -> anyhow::Result<()> {
    let path = data_file_path("providers.json")?;
    fs::write(path, serde_json::to_string_pretty(store)?)?;
    Ok(())
}

pub fn load_credentials() -> CredentialStore {
    let path = match data_file_path(CREDENTIALS_FILE) {
        Ok(p) => p,
        Err(_) => return CredentialStore::default(),
    };
    if !path.exists() {
        return CredentialStore::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_credentials(store: &CredentialStore) -> anyhow::Result<()> {
    let path = data_file_path(CREDENTIALS_FILE)?;
    fs::write(path, serde_json::to_string_pretty(store)?)?;
    Ok(())
}
