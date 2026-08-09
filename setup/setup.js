#!/usr/bin/env node
'use strict';

// Single entry point replacing the previous 4 separate .bat scripts
// (build-extension.bat, start-terminal-host.bat [dead — superseded by
// auto-launch, not ported], terminal-host/install-native-messaging-host.bat,
// lsp-host/install-native-messaging-host.bat). Run with `node setup/setup.js`.
//
// Builds the extension and both Rust companion processes, then registers
// each as a Native Messaging host so the browser extension can launch them
// (the only way an extension can start a local process at all).
//
// Windows-only for now; the platform dispatch (installWindows/installLinux)
// is deliberately structured so adding Linux later is a contained addition
// — see installLinux()'s comment for what that would involve.
//
// --skip-native-messaging: some org-managed Edge installs set the
// NativeMessagingUserLevelHosts policy to disable HKCU registration
// outright, which forces HKLM registration — and that needs local admin
// rights this script's user may simply not have (nothing on the Edge or
// Windows side to work around; the policy exists specifically to require
// admin approval for native messaging hosts). Pass this flag to still
// build both companion processes but skip registration entirely, and fall
// back to launching terminal-host.exe/lsp-host.exe by hand and pasting
// their printed port/token into the extension once — see the printed
// instructions at the end of a `--skip-native-messaging` run.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const EXT_ID = 'fehlbbjdbgjgjnbgjnhcehkdgnlagboo';
const SKIP_NATIVE_MESSAGING = process.argv.includes('--skip-native-messaging');
// Internal-only flag relaunchElevated() passes to itself: the original
// (pre-JS-port) install-native-messaging-host.bat only ever re-elevated a
// small, build-free registration step — building was a wholly separate
// script. This setup.js's elevated relaunch re-runs the whole file, so
// without this flag it would also redo npm run build + two cargo release
// builds a second time for nothing, since the non-elevated parent process
// already just did them seconds earlier.
const REGISTER_ONLY = process.argv.includes('--register-only');

const HOSTS = [
  {
    dir: 'terminal-host',
    exeName: 'terminal-host.exe',
    hostName: 'com.m365copilot.terminal_host_launcher',
    description: 'Launches the terminal-host companion process for M365 Copilot Code Editor',
  },
  {
    dir: 'lsp-host',
    exeName: 'lsp-host.exe',
    hostName: 'com.edgellmagenteditor.lsp_host',
    description: 'Launches the lsp-host companion process for EdgeLLMAgentEditor',
  },
];

function log(message) {
  console.log(`[setup] ${message}`);
}

// With `shell: true` on Windows, Node hands args to cmd.exe already
// concatenated — it does NOT quote them for you (Node itself warns about
// this: "arguments are not escaped, only concatenated"). Any arg containing
// a space (e.g. reg.exe's /d value, built from REPO_ROOT — broken on any
// checkout path with a space in it, such as a Windows username with a
// space, "OneDrive - ..." sync folders, etc.) silently splits into extra
// tokens and corrupts the command. Windows paths can never contain a
// literal double quote, so a plain wrap-if-it-has-whitespace is sufficient.
function quoteArgForWindowsShell(arg) {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

function run(cmd, args, cwd) {
  const shell = process.platform === 'win32';
  const safeArgs = shell ? args.map(quoteArgForWindowsShell) : args;
  const result = spawnSync(cmd, safeArgs, { cwd, stdio: 'inherit', shell });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit code ${result.status})`);
  }
}

function buildExtension() {
  const extensionDir = path.join(REPO_ROOT, 'extension');
  if (!fs.existsSync(path.join(extensionDir, 'node_modules'))) {
    log('Installing extension dependencies...');
    run('npm', ['install'], extensionDir);
  }
  log('Building extension...');
  run('npm', ['run', 'build'], extensionDir);
}

function buildRustHost(hostDir) {
  log(`Building ${hostDir} (cargo build --release)...`);
  run('cargo', ['build', '--release'], path.join(REPO_ROOT, hostDir));
}

function findExe(hostDir, exeName) {
  const release = path.join(REPO_ROOT, hostDir, 'target', 'release', exeName);
  const debug = path.join(REPO_ROOT, hostDir, 'target', 'debug', exeName);
  if (fs.existsSync(release)) return release;
  if (fs.existsSync(debug)) return debug;
  throw new Error(`${exeName} not found after build (looked in target/release and target/debug)`);
}

// --- Windows: Native Messaging host registration ---
// Mirrors the two original .bat scripts exactly (same policy probe, same
// HKCU/HKLM + UAC-elevation decision), just in one place instead of
// duplicated per host.

function isUserLevelDisabledOnWindows() {
  // Checks the documented Edge policy name, plus the singular spelling
  // used by some existing enterprise setup scripts, in both registry
  // views/hives — same probe the original .bat files used.
  const script = `
    $names=@('NativeMessagingUserLevelHosts','NativeMessagingUserLevelHost');
    $hives=@([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryHive]::CurrentUser);
    $views=@([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32);
    foreach($hive in $hives){
      foreach($view in $views){
        $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view);
        $key=$base.OpenSubKey('SOFTWARE\\Policies\\Microsoft\\Edge');
        if($null -ne $key){
          foreach($name in $names){
            $value=$key.GetValue($name);
            if($null -ne $value -and [int]$value -eq 0){ exit 0 }
          }
        }
      }
    };
    exit 1
  `;
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ]);
  return result.status === 0;
}

function isElevated() {
  // fltmc only succeeds with administrator rights — same trick the
  // original .bat files used to detect elevation.
  const result = spawnSync('fltmc', [], { stdio: 'ignore', shell: true });
  return result.status === 0;
}

function relaunchElevated() {
  log('Edge disables user-level Native Messaging; administrator permission is needed.');
  log('Requesting elevation...');
  // Re-runs this same script elevated — there is no separate install.js
  // (that file never existed in this repo; a stale reference to one here
  // meant elevation silently did nothing: node failed with "Cannot find
  // module", relaunchElevated() still called process.exit() with that
  // failure's code, and nothing in setup.js's own flow surfaced it as an
  // error, so registration just silently never happened whenever HKLM/
  // elevation was required). --register-only skips the redundant rebuild
  // (see REGISTER_ONLY above) — the pre-JS-port .bat only ever re-elevated
  // the lightweight registration step, never a full rebuild.
  const scriptPath = __filename;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `$p = Start-Process -FilePath 'node' -ArgumentList '"${scriptPath}" --register-only' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`,
    ],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}

function registerNativeMessagingHostWindows(host, exePath, regRoot) {
  const manifestPath = path.join(REPO_ROOT, host.dir, 'native-messaging-host-manifest.json');
  const manifest = {
    name: host.hostName,
    description: host.description,
    path: exePath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXT_ID}/`],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const keyPath = `${regRoot}\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${host.hostName}`;
  run('reg', ['add', keyPath, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']);
  log(`Registered ${host.hostName} in ${regRoot}`);
  log(`  exe:      ${exePath}`);
  log(`  manifest: ${manifestPath}`);
}

function installWindows() {
  if (!REGISTER_ONLY) {
    for (const host of HOSTS) {
      buildRustHost(host.dir);
    }
  }

  if (SKIP_NATIVE_MESSAGING) {
    log('--skip-native-messaging: leaving Native Messaging host registration untouched.');
    return;
  }

  const regRoot = isUserLevelDisabledOnWindows() ? 'HKLM' : 'HKCU';
  if (regRoot === 'HKLM' && !isElevated()) {
    relaunchElevated();
    return; // relaunchElevated() always exits the process itself
  }

  for (const host of HOSTS) {
    const exePath = findExe(host.dir, host.exeName);
    registerNativeMessagingHostWindows(host, exePath, regRoot);
  }
}

// --- Linux: not yet implemented ---
//
// When picking this up: Native Messaging host registration on Linux (and
// on macOS) has no registry involved at all — it's a JSON manifest file
// (identical shape to Windows: name/description/path/type/allowed_origins,
// see registerNativeMessagingHostWindows above) dropped into a per-browser
// config directory, e.g. for Chrome-family browsers:
//   ~/.config/google-chrome/NativeMessagingHosts/<host-name>.json
//   ~/.config/microsoft-edge/NativeMessagingHosts/<host-name>.json
// (exact directory depends on which browser/channel is installed — may
// need to detect or ask). No UAC-equivalent elevation dance is needed:
// user-level Native Messaging just works, so `installLinux()` should be
// considerably simpler than `installWindows()` — build both hosts (`cargo
// build --release`, same as Windows), write the manifest into the right
// directory, done.
function installLinux() {
  console.error('[setup] Linux is not yet supported by this setup script.');
  console.error('[setup] See the comment above installLinux() in setup/setup.js for what remains.');
  process.exit(1);
}

function main() {
  if (!REGISTER_ONLY) buildExtension();

  if (process.platform === 'win32') {
    installWindows();
  } else if (process.platform === 'linux') {
    installLinux();
  } else {
    console.error(`[setup] Unsupported platform: ${process.platform}`);
    process.exit(1);
  }

  log('Done. Load extension/dist as an unpacked extension in edge://extensions (or reload it if already loaded).');

  if (SKIP_NATIVE_MESSAGING) {
    log('');
    log('Native Messaging registration was skipped, so the extension cannot auto-launch');
    log('the companion processes.');
    log('');
    log(`terminal-host has a manual fallback: run ${findExe('terminal-host', 'terminal-host.exe')}`);
    log('directly (e.g. double-click it), then paste the port/token it prints into the');
    log('extension once. Both are saved to disk and reused on every restart (see');
    log('terminal-host/src/config.rs\'s load_or_create), so this is a one-time step —');
    log('just make sure the .exe is already running (a shortcut in your Windows Startup');
    log('folder works well) before opening the extension, and it reconnects on its own.');
    log('');
    log('lsp-host has NO such fallback yet — it only ever connects via Native Messaging,');
    log('so language server features (autocomplete, diagnostics, ...) will not work at');
    log('all under --skip-native-messaging. The editor and terminal are otherwise fully');
    log('usable without it.');
  }
}

main();
