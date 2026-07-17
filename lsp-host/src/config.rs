use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_PORT: u16 = 51881;
pub const PORT_FALLBACKS: [u16; 3] = [51882, 51883, 51884];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HostConfig {
    pub token: String,
    pub port: u16,
}

fn config_dir() -> PathBuf {
    dirs::config_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("EdgeLLMAgentEditor")
        .join("lsp-host")
}

fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Loads the persisted token/port, or creates and persists a new one on
/// first run. The token only changes if the user deletes the config file.
/// Both the long-running WS server (main.rs) and the short-lived native
/// messaging launcher (native_messaging.rs) call this and get the same
/// values, which is what lets the launcher hand the token back to the
/// browser directly in its response (see native_messaging.rs) instead of
/// requiring a manual copy-paste settings step.
pub fn load_or_create() -> anyhow::Result<HostConfig> {
    let path = config_path();
    if let Ok(contents) = std::fs::read_to_string(&path)
        && let Ok(cfg) = serde_json::from_str::<HostConfig>(&contents)
    {
        return Ok(cfg);
    }

    let cfg = HostConfig {
        token: generate_token(),
        port: DEFAULT_PORT,
    };
    std::fs::create_dir_all(config_dir())?;
    std::fs::write(&path, serde_json::to_string_pretty(&cfg)?)?;
    Ok(cfg)
}
