import { create } from 'zustand';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';

/** name -> full command string, e.g. { test: "npm test", diff: "git diff" }.
 * Unlike RunCommandMap (runCommandStore.ts), these aren't tied to any file
 * — Copilot names one by `TOOL_RUN_NAMED: test` instead of a file path, for
 * project-level commands (tests, git, lint, build) that have no single
 * file to run. No defaults: unlike a language's interpreter, "test"/"build"
 * mean something different in every project, so there's nothing safe to
 * pre-seed. */
export type NamedCommandMap = Record<string, string>;

const STORAGE_KEY = 'namedCommands';

interface NamedCommandState {
  commands: NamedCommandMap;
  loadCommands: () => Promise<void>;
  saveCommands: (commands: NamedCommandMap) => Promise<void>;
}

export const useNamedCommandStore = create<NamedCommandState>((set) => ({
  commands: {},

  loadCommands: async () => {
    const stored = await getStoredValue<NamedCommandMap>(STORAGE_KEY);
    set({ commands: stored ?? {} });
  },

  saveCommands: async (commands: NamedCommandMap) => {
    await setStoredValue(STORAGE_KEY, commands);
    set({ commands });
  },
}));
