import { create } from 'zustand';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';
import { DEFAULT_PROMPT_TEMPLATE } from '../copilot/promptTemplates';

const STORAGE_KEY = 'copilotPromptTemplate';

interface PromptTemplateState {
  template: string;
  loadTemplate: () => Promise<void>;
  saveTemplate: (template: string) => Promise<void>;
}

export const usePromptTemplateStore = create<PromptTemplateState>((set) => ({
  template: DEFAULT_PROMPT_TEMPLATE,

  loadTemplate: async () => {
    const stored = await getStoredValue<string>(STORAGE_KEY);
    set({ template: stored ?? DEFAULT_PROMPT_TEMPLATE });
  },

  saveTemplate: async (template: string) => {
    await setStoredValue(STORAGE_KEY, template);
    set({ template });
  },
}));
