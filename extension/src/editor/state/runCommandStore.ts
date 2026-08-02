import { create } from 'zustand';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';

/** extension (no leading dot, lowercase) -> command template containing
 * "{file}", e.g. { py: "python {file}" }. */
export type RunCommandMap = Record<string, string>;

const STORAGE_KEY = 'runCommandsByExtension';

/** Seeded once on first use, then persisted as ordinary editable/removable
 * rows — only for interpreters with one unambiguous, universally-expected
 * invocation. Deliberately excludes anything that needs a build step or
 * has multiple common runners (ts, java, c/cpp, go, rs, sh — the last
 * because bash isn't a given on Windows). */
const DEFAULT_RUN_COMMANDS: RunCommandMap = {
  py: 'python {file}',
  js: 'node {file}',
  ps1: 'powershell -ExecutionPolicy Bypass -File {file}',
  rb: 'ruby {file}',
  php: 'php {file}',
  pl: 'perl {file}',
  lua: 'lua {file}',
  r: 'Rscript {file}',
  jl: 'julia {file}',
  bat: 'cmd /c {file}',
  cmd: 'cmd /c {file}',
  vbs: 'cscript //nologo {file}',
};

interface RunCommandState {
  commands: RunCommandMap;
  loadCommands: () => Promise<void>;
  saveCommands: (commands: RunCommandMap) => Promise<void>;
}

export const useRunCommandStore = create<RunCommandState>((set) => ({
  commands: {},

  loadCommands: async () => {
    const stored = await getStoredValue<RunCommandMap>(STORAGE_KEY);
    if (stored === undefined) {
      // First run only — an explicitly-saved {} (user cleared everything)
      // is left alone, since that's a deliberate choice, not "unconfigured".
      await setStoredValue(STORAGE_KEY, DEFAULT_RUN_COMMANDS);
      set({ commands: DEFAULT_RUN_COMMANDS });
      return;
    }
    set({ commands: stored });
  },

  saveCommands: async (commands: RunCommandMap) => {
    await setStoredValue(STORAGE_KEY, commands);
    set({ commands });
  },
}));

export function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return null;
  return fileName.slice(dot + 1).toLowerCase();
}

export function buildRunCommand(template: string, realFilePath: string): string {
  const quoted = /\s/.test(realFilePath) ? `"${realFilePath}"` : realFilePath;
  return template.replaceAll('{file}', quoted);
}

export function buildDebugCommand(template: string, realFilePath: string, breakpoints: number[]): string {
  return buildRunCommand(template, realFilePath).replaceAll('{breakpoints}', breakpoints.join(','));
}
