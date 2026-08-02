import { create } from 'zustand';
import { readFileText, writeFileText } from '../fs/fsaWorkspace';
import { useWorkspaceStore } from './workspaceStore';

export interface ProjectTask {
  id?: string;
  label?: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  problemMatcher?: unknown;
  [key: string]: unknown;
}

export interface ProjectTasksFile {
  version?: number;
  tasks: ProjectTask[];
  [key: string]: unknown;
}

export interface ProjectLaunchConfiguration {
  name?: string;
  type?: string;
  request?: string;
  [key: string]: unknown;
}

export interface ProjectLaunchFile {
  version?: number;
  configurations: ProjectLaunchConfiguration[];
  [key: string]: unknown;
}

interface ProjectTaskState {
  tasksJson: string;
  launchJson: string;
  tasksExists: boolean;
  launchExists: boolean;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  errorMessage: string | null;
  loadProjectSettings: () => Promise<void>;
  saveProjectSettings: (tasksJson: string, launchJson: string) => Promise<void>;
  setTasksJson: (value: string) => void;
  setLaunchJson: (value: string) => void;
}

const EMPTY_PROJECT_JSON = '';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseProjectTasks(value: string): ProjectTask[] {
  if (!value.trim()) return [];
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) {
    throw new Error('tasks.json は tasks 配列を含むJSONオブジェクトで指定してください。');
  }
  if (!parsed.tasks.every((task) => isRecord(task) && typeof task.command === 'string')) {
    throw new Error('tasks.json の各タスクには command 文字列が必要です。');
  }
  return parsed.tasks as ProjectTask[];
}

export function parseProjectLaunchConfigurations(value: string): ProjectLaunchConfiguration[] {
  if (!value.trim()) return [];
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || !Array.isArray(parsed.configurations)) {
    throw new Error('launch.json は configurations 配列を含むJSONオブジェクトで指定してください。');
  }
  if (!parsed.configurations.every(isRecord)) {
    throw new Error('launch.json の configurations にはJSONオブジェクトを指定してください。');
  }
  return parsed.configurations as ProjectLaunchConfiguration[];
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

async function readProjectFile(
  rootHandle: FileSystemDirectoryHandle,
  fileName: string,
): Promise<{ exists: boolean; value: string }> {
  try {
    const projectDirectory = await rootHandle.getDirectoryHandle('.m365ce');
    const fileHandle = await projectDirectory.getFileHandle(fileName);
    return { exists: true, value: await readFileText(fileHandle) };
  } catch (error) {
    if (isNotFound(error)) return { exists: false, value: EMPTY_PROJECT_JSON };
    throw error;
  }
}

export const useProjectTaskStore = create<ProjectTaskState>((set) => ({
  tasksJson: EMPTY_PROJECT_JSON,
  launchJson: EMPTY_PROJECT_JSON,
  tasksExists: false,
  launchExists: false,
  loaded: false,
  loading: false,
  saving: false,
  errorMessage: null,

  loadProjectSettings: async () => {
    const rootHandle = useWorkspaceStore.getState().rootHandle;
    if (!rootHandle) {
      set({ tasksJson: EMPTY_PROJECT_JSON, launchJson: EMPTY_PROJECT_JSON, tasksExists: false, launchExists: false, loaded: true, loading: false, errorMessage: null });
      return;
    }
    set({ loading: true, loaded: false, errorMessage: null });
    try {
      const [tasks, launch] = await Promise.all([
        readProjectFile(rootHandle, 'tasks.json'),
        readProjectFile(rootHandle, 'launch.json'),
      ]);
      set({
        tasksJson: tasks.value,
        launchJson: launch.value,
        tasksExists: tasks.exists,
        launchExists: launch.exists,
        loaded: true,
        loading: false,
        errorMessage: null,
      });
    } catch (error) {
      set({ loaded: true, loading: false, errorMessage: error instanceof Error ? error.message : 'プロジェクト設定を読み込めません。' });
    }
  },

  saveProjectSettings: async (tasksJson, launchJson) => {
    const rootHandle = useWorkspaceStore.getState().rootHandle;
    if (!rootHandle) throw new Error('ワークスペースを開いてからプロジェクト設定を保存してください。');
    set({ saving: true, errorMessage: null });
    try {
      const projectDirectory = await rootHandle.getDirectoryHandle('.m365ce', { create: true });
      const [tasksHandle, launchHandle] = await Promise.all([
        projectDirectory.getFileHandle('tasks.json', { create: true }),
        projectDirectory.getFileHandle('launch.json', { create: true }),
      ]);
      await Promise.all([
        writeFileText(tasksHandle, tasksJson),
        writeFileText(launchHandle, launchJson),
      ]);
      set({ tasksJson, launchJson, tasksExists: true, launchExists: true, loaded: true, saving: false, errorMessage: null });
    } catch (error) {
      set({ saving: false, errorMessage: error instanceof Error ? error.message : 'プロジェクト設定を保存できません。' });
      throw error;
    }
  },

  setTasksJson: (tasksJson) => set({ tasksJson }),
  setLaunchJson: (launchJson) => set({ launchJson }),
}));
