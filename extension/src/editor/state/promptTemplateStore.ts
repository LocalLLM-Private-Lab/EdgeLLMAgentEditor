import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';
import { DEFAULT_EDIT_TEMPLATE, DEFAULT_EXPLAIN_TEMPLATE } from '../copilot/promptTemplates';

const TEMPLATES_KEY = 'copilotPromptTemplates';
const SELECTED_KEY = 'copilotSelectedPromptTemplateId';

export interface PromptTemplateEntry {
  id: string;
  name: string;
  template: string;
}

const DEFAULT_TEMPLATES: PromptTemplateEntry[] = [
  { id: 'edit', name: 'ファイル編集', template: DEFAULT_EDIT_TEMPLATE },
  { id: 'explain', name: 'コード解析・説明', template: DEFAULT_EXPLAIN_TEMPLATE },
];

interface PromptTemplateState {
  templates: PromptTemplateEntry[];
  selectedTemplateId: string;
  loaded: boolean;
  loadTemplates: () => Promise<void>;
  saveTemplates: (templates: PromptTemplateEntry[]) => Promise<void>;
  selectTemplate: (id: string) => void;
  selectedTemplate: () => PromptTemplateEntry;
}

export const usePromptTemplateStore = create<PromptTemplateState>((set, get) => ({
  templates: DEFAULT_TEMPLATES,
  selectedTemplateId: DEFAULT_TEMPLATES[0].id,
  loaded: false,

  loadTemplates: async () => {
    const [storedTemplates, storedSelected] = await Promise.all([
      getStoredValue<PromptTemplateEntry[]>(TEMPLATES_KEY),
      getStoredValue<string>(SELECTED_KEY),
    ]);
    const templates =
      storedTemplates && storedTemplates.length > 0 ? storedTemplates : DEFAULT_TEMPLATES;
    const selectedTemplateId =
      storedSelected && templates.some((t) => t.id === storedSelected)
        ? storedSelected
        : templates[0].id;
    set({ templates, selectedTemplateId, loaded: true });
  },

  saveTemplates: async (templates: PromptTemplateEntry[]) => {
    await setStoredValue(TEMPLATES_KEY, templates);
    const selectedTemplateId = templates.some((t) => t.id === get().selectedTemplateId)
      ? get().selectedTemplateId
      : (templates[0]?.id ?? '');
    set({ templates, selectedTemplateId });
    await setStoredValue(SELECTED_KEY, selectedTemplateId);
  },

  selectTemplate: (id: string) => {
    set({ selectedTemplateId: id });
    void setStoredValue(SELECTED_KEY, id);
  },

  selectedTemplate: () => {
    const { templates, selectedTemplateId } = get();
    return templates.find((t) => t.id === selectedTemplateId) ?? templates[0];
  },
}));

export function newPromptTemplateEntry(name = '新しいテンプレート', template = ''): PromptTemplateEntry {
  return { id: uuid(), name, template };
}
