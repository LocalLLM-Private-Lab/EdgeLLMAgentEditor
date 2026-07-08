use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_PORT: u16 = 51877;
pub const PORT_FALLBACKS: [u16; 3] = [51878, 51879, 51880];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HostConfig {
    pub token: String,
    pub port: u16,
}

fn config_dir() -> PathBuf {
    dirs::config_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("m365-copilot-editor-terminal-host")
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
pub fn load_or_create() -> anyhow::Result<HostConfig> {
    let path = config_path();
    if let Ok(contents) = std::fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<HostConfig>(&contents) {
            return Ok(cfg);
        }
    }

    let cfg = HostConfig {
        token: generate_token(),
        port: DEFAULT_PORT,
    };
    std::fs::create_dir_all(config_dir())?;
    std::fs::write(&path, serde_json::to_string_pretty(&cfg)?)?;
    Ok(cfg)
}
