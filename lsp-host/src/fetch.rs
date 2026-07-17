//! Auto-fetch of rust-analyzer from GitHub Releases. `tag_name` on this repo
//! is a release date (e.g. "2026-07-13"), not semver, so the version to
//! download can only be discovered by calling the API — never guess a tag.

use futures_util::StreamExt;
use serde::Deserialize;
use std::path::PathBuf;

const RELEASES_URL: &str = "https://api.github.com/repos/rust-lang/rust-analyzer/releases/latest";
const WINDOWS_ASSET_NAME: &str = "rust-analyzer-x86_64-pc-windows-msvc.zip";
const USER_AGENT: &str = "EdgeLLMAgentEditor-lsp-host";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

fn cache_root() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("EdgeLLMAgentEditor")
        .join("lsp-host")
        .join("rust-analyzer")
}

fn cached_exe_path(version: &str) -> PathBuf {
    cache_root().join(version).join("rust-analyzer.exe")
}

/// Looks for any already-downloaded rust-analyzer.exe under the cache root,
/// without hitting the network. Version directories are named after
/// GitHub's `tag_name` (a `YYYY-MM-DD` release date), which sorts newest-last
/// lexicographically, so the last entry is the newest cached version. Lets a
/// second session reuse the binary instantly instead of re-querying the
/// GitHub API (and requiring network access) on every `OpenSession`.
pub fn find_cached_exe() -> Option<PathBuf> {
    let mut versions: Vec<_> = std::fs::read_dir(cache_root())
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .collect();
    versions.sort();
    versions
        .into_iter()
        .rev()
        .find_map(|dir| {
            let exe = dir.join("rust-analyzer.exe");
            exe.is_file().then_some(exe)
        })
}

/// Returns the path to a working rust-analyzer.exe, downloading and
/// unzipping it first if not already cached for the latest release.
/// `on_progress` is called repeatedly while the archive downloads.
pub async fn ensure_rust_analyzer(
    on_progress: impl Fn(u64, Option<u64>) + Send + 'static,
) -> anyhow::Result<PathBuf> {
    let client = reqwest::Client::builder().user_agent(USER_AGENT).build()?;

    let release: Release = client
        .get(RELEASES_URL)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let exe_path = cached_exe_path(&release.tag_name);
    if exe_path.is_file() {
        return Ok(exe_path);
    }

    let asset = release
        .assets
        .iter()
        .find(|a| a.name == WINDOWS_ASSET_NAME)
        .ok_or_else(|| {
            anyhow::anyhow!("no '{WINDOWS_ASSET_NAME}' asset in rust-analyzer release {}", release.tag_name)
        })?;

    let resp = client
        .get(&asset.browser_download_url)
        .send()
        .await?
        .error_for_status()?;
    let total = resp.content_length();

    let mut downloaded: u64 = 0;
    let mut archive_bytes = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        downloaded += chunk.len() as u64;
        archive_bytes.extend_from_slice(&chunk);
        on_progress(downloaded, total);
    }

    let dest_dir = exe_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("cached exe path has no parent directory"))?
        .to_path_buf();
    std::fs::create_dir_all(&dest_dir)?;

    // The `zip` crate's API is synchronous; extraction is CPU/disk-bound
    // rather than async-friendly, so it runs on a blocking-pool thread.
    //
    // The archive's internal entry name is *not* assumed to be exactly
    // "rust-analyzer.exe" (only the outer asset filename was actually
    // verified against the live GitHub API — the entry name inside it
    // wasn't). Whatever `.exe` the archive contains is extracted as-is,
    // then renamed to the canonical `exe_path` so `find_cached_exe()`'s own
    // "rust-analyzer.exe" assumption stays valid for later lookups.
    let exe_path_for_extract = exe_path.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let cursor = std::io::Cursor::new(archive_bytes);
        let mut archive = zip::ZipArchive::new(cursor)?;
        let mut extracted_exe: Option<PathBuf> = None;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            let Some(name) = entry.enclosed_name() else {
                continue;
            };
            let out_path = dest_dir.join(&name);
            if entry.is_dir() {
                std::fs::create_dir_all(&out_path)?;
                continue;
            }
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out_file = std::fs::File::create(&out_path)?;
            std::io::copy(&mut entry, &mut out_file)?;
            if name.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe")) {
                extracted_exe = Some(out_path);
            }
        }

        let extracted_exe = extracted_exe
            .ok_or_else(|| anyhow::anyhow!("no .exe entry found in the downloaded rust-analyzer archive"))?;
        if extracted_exe != exe_path_for_extract {
            std::fs::rename(&extracted_exe, &exe_path_for_extract)?;
        }
        Ok(())
    })
    .await??;

    if !exe_path.is_file() {
        anyhow::bail!("extraction completed but {} was not produced", exe_path.display());
    }

    Ok(exe_path)
}
