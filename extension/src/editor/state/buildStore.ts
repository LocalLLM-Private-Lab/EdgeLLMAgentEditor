import { create } from 'zustand';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';

export type BuildAction = 'build' | 'run' | 'debug';

interface BuildState {
  buildCommand: string;
  debugCommand: string;
  debugAdapterCommand: string;
  debugAdapterArgs: string;
  autoInstallDebugAdapter: boolean;
  debugLaunchConfig: string;
  output: string;
  lastCommand: string;
  lastExitCode: number | null;
  running: boolean;
  pendingAction: BuildAction | null;
  loadSettings: () => Promise<void>;
  setBuildCommand: (command: string) => void;
  setDebugCommand: (command: string) => void;
  setDebugAdapterCommand: (command: string) => void;
  setDebugAdapterArgs: (args: string) => void;
  setAutoInstallDebugAdapter: (enabled: boolean) => void;
  setDebugLaunchConfig: (config: string) => void;
  saveSettings: () => Promise<void>;
  setResult: (result: { output: string; command: string; exitCode: number | null }) => void;
  setRunning: (running: boolean) => void;
  requestAction: (action: BuildAction) => void;
  consumeAction: () => BuildAction | null;
  clearOutput: () => void;
}

const STORAGE_KEY = 'buildAndDebugCommands';
const EMPTY_OUTPUT = 'まだビルド・実行は行われていません。';
export const DEFAULT_DEBUG_LAUNCH_CONFIG = '{"type":"python","request":"launch","program":"{file}","cwd":"{workspace}"}';

export const useBuildStore = create<BuildState>((set, get) => ({
  buildCommand: '',
  debugCommand: '',
  output: EMPTY_OUTPUT,
  lastCommand: '',
  lastExitCode: null,
  running: false,
  pendingAction: null,
  debugAdapterCommand: '',
  debugAdapterArgs: '',
  autoInstallDebugAdapter: true,
  debugLaunchConfig: DEFAULT_DEBUG_LAUNCH_CONFIG,
  loadSettings: async () => {
    const stored = await getStoredValue<Pick<BuildState, 'buildCommand' | 'debugCommand' | 'debugAdapterCommand' | 'debugAdapterArgs' | 'autoInstallDebugAdapter' | 'debugLaunchConfig'>>(STORAGE_KEY);
    if (stored) set({
      buildCommand: stored.buildCommand ?? '',
      debugCommand: stored.debugCommand ?? '',
      debugAdapterCommand: stored.debugAdapterCommand ?? '',
      debugAdapterArgs: stored.debugAdapterArgs ?? '',
      autoInstallDebugAdapter: stored.autoInstallDebugAdapter ?? true,
      debugLaunchConfig: stored.debugLaunchConfig ?? DEFAULT_DEBUG_LAUNCH_CONFIG,
    });
  },
  setBuildCommand: (buildCommand) => set({ buildCommand }),
  setDebugCommand: (debugCommand) => set({ debugCommand }),
  setDebugAdapterCommand: (debugAdapterCommand) => set({ debugAdapterCommand }),
  setDebugAdapterArgs: (debugAdapterArgs) => set({ debugAdapterArgs }),
  setAutoInstallDebugAdapter: (autoInstallDebugAdapter) => set({ autoInstallDebugAdapter }),
  setDebugLaunchConfig: (debugLaunchConfig) => set({ debugLaunchConfig }),
  saveSettings: async () => {
    const state = get();
    await setStoredValue(STORAGE_KEY, {
      buildCommand: state.buildCommand,
      debugCommand: state.debugCommand,
      debugAdapterCommand: state.debugAdapterCommand,
      debugAdapterArgs: state.debugAdapterArgs,
      autoInstallDebugAdapter: state.autoInstallDebugAdapter,
      debugLaunchConfig: state.debugLaunchConfig,
    });
  },
  setResult: ({ output, command, exitCode }) => set({ output, lastCommand: command, lastExitCode: exitCode }),
  setRunning: (running) => set({ running }),
  requestAction: (pendingAction) => set({ pendingAction }),
  consumeAction: () => {
    const action = get().pendingAction;
    set({ pendingAction: null });
    return action;
  },
  clearOutput: () => set({ output: EMPTY_OUTPUT, lastCommand: '', lastExitCode: null }),
}));
