import { create } from 'zustand';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';
import type { PlanStep } from '../copilot/planParser';

const STORAGE_KEY = 'copilotPlan';

export interface PlanData {
  goal: string;
  /** '/'-joined relative paths added as context for the planning prompt. */
  contextFiles: string[];
  steps: PlanStep[];
  activeStepId: string | null;
}

const EMPTY_PLAN: PlanData = { goal: '', contextFiles: [], steps: [], activeStepId: null };

interface PlanState extends PlanData {
  loaded: boolean;
  loadPlan: () => Promise<void>;
  setGoal: (goal: string) => void;
  addContextFile: (path: string) => void;
  removeContextFile: (path: string) => void;
  setSteps: (steps: PlanStep[]) => void;
  setStepStatus: (id: string, status: PlanStep['status']) => void;
  setStepFiles: (id: string, files: string[]) => void;
  setActiveStepId: (id: string | null) => void;
  resetPlan: () => void;
}

// Persists a full PlanData snapshot on every mutation — the whole plan
// (goal, context files, steps + their status) survives closing the tab, per
// the earlier decision that a multi-file task shouldn't be lost mid-way.
function apply(
  set: (patch: Partial<PlanState>) => void,
  get: () => PlanState,
  patch: Partial<PlanData>,
) {
  set(patch);
  const { goal, contextFiles, steps, activeStepId } = { ...get(), ...patch };
  void setStoredValue<PlanData>(STORAGE_KEY, { goal, contextFiles, steps, activeStepId });
}

export const usePlanStore = create<PlanState>((set, get) => ({
  ...EMPTY_PLAN,
  loaded: false,

  loadPlan: async () => {
    const stored = await getStoredValue<PlanData>(STORAGE_KEY);
    set({ ...(stored ?? EMPTY_PLAN), loaded: true });
  },

  setGoal: (goal) => apply(set, get, { goal }),

  addContextFile: (path) => {
    const { contextFiles } = get();
    if (contextFiles.includes(path)) return;
    apply(set, get, { contextFiles: [...contextFiles, path] });
  },

  removeContextFile: (path) => {
    apply(set, get, { contextFiles: get().contextFiles.filter((p) => p !== path) });
  },

  setSteps: (steps) => {
    apply(set, get, { steps, activeStepId: steps[0]?.id ?? null });
  },

  setStepStatus: (id, status) => {
    apply(set, get, { steps: get().steps.map((s) => (s.id === id ? { ...s, status } : s)) });
  },

  setStepFiles: (id, files) => {
    apply(set, get, { steps: get().steps.map((s) => (s.id === id ? { ...s, files } : s)) });
  },

  setActiveStepId: (id) => apply(set, get, { activeStepId: id }),

  resetPlan: () => apply(set, get, EMPTY_PLAN),
}));
