import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

export interface EditorDiffView {
  id: string;
  groupId: string;
  title: string;
  originalName: string;
  modifiedName: string;
  original: string;
  modified: string;
  language: string;
  /** Reuse the live editor model when the modified file is already open. */
  modifiedFileId?: string;
  /** Reuse the live editor model when the original file is already open. */
  originalFileId?: string;
  /** File-to-file comparisons allow editing both sides. */
  bothEditable?: boolean;
}

interface DiffViewState {
  views: EditorDiffView[];
  activeByGroup: Record<string, string | null | undefined>;
  openDiff: (
    groupId: string,
    input: Omit<EditorDiffView, 'id' | 'groupId'>,
  ) => string;
  setActiveDiff: (groupId: string, id: string | null) => void;
  closeDiff: (groupId: string, id: string) => void;
  deactivateDiff: (groupId: string) => void;
}

export const useDiffViewStore = create<DiffViewState>((set) => ({
  views: [],
  activeByGroup: {},
  openDiff: (groupId, input) => {
    const id = uuidv4();
    set((state) => ({
      views: [...state.views, { ...input, id, groupId }],
      activeByGroup: { ...state.activeByGroup, [groupId]: id },
    }));
    return id;
  },
  setActiveDiff: (groupId, id) =>
    set((state) => ({
      activeByGroup: { ...state.activeByGroup, [groupId]: id },
    })),
  closeDiff: (groupId, id) =>
    set((state) => ({
      views: state.views.filter((view) => view.id !== id),
      activeByGroup: {
        ...state.activeByGroup,
        [groupId]: state.activeByGroup[groupId] === id ? null : state.activeByGroup[groupId],
      },
    })),
  deactivateDiff: (groupId) =>
    set((state) => ({
      activeByGroup: { ...state.activeByGroup, [groupId]: null },
    })),
}));
