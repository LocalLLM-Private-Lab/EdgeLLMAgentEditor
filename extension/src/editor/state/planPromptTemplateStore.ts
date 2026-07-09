import { create } from 'zustand';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';
import { DEFAULT_PLAN_PROMPT_TEMPLATE, DEFAULT_STEP_PROMPT_TEMPLATE } from '../copilot/planPromptTemplates';

const PLAN_KEY = 'copilotPlanPromptTemplate';
const STEP_KEY = 'copilotStepPromptTemplate';

interface PlanPromptTemplateState {
  planTemplate: string;
  stepTemplate: string;
  loadTemplates: () => Promise<void>;
  savePlanTemplate: (template: string) => Promise<void>;
  saveStepTemplate: (template: string) => Promise<void>;
}

export const usePlanPromptTemplateStore = create<PlanPromptTemplateState>((set) => ({
  planTemplate: DEFAULT_PLAN_PROMPT_TEMPLATE,
  stepTemplate: DEFAULT_STEP_PROMPT_TEMPLATE,

  loadTemplates: async () => {
    const [plan, step] = await Promise.all([
      getStoredValue<string>(PLAN_KEY),
      getStoredValue<string>(STEP_KEY),
    ]);
    set({
      planTemplate: plan ?? DEFAULT_PLAN_PROMPT_TEMPLATE,
      stepTemplate: step ?? DEFAULT_STEP_PROMPT_TEMPLATE,
    });
  },

  savePlanTemplate: async (template) => {
    await setStoredValue(PLAN_KEY, template);
    set({ planTemplate: template });
  },

  saveStepTemplate: async (template) => {
    await setStoredValue(STEP_KEY, template);
    set({ stepTemplate: template });
  },
}));
