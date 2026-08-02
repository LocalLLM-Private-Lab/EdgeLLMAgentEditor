import { useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';
import {
  usePromptTemplateStore,
  newPromptTemplateEntry,
  type PromptTemplateEntry,
} from '../state/promptTemplateStore';
import { usePlanPromptTemplateStore } from '../state/planPromptTemplateStore';
import { DEFAULT_PLAN_PROMPT_TEMPLATE, DEFAULT_STEP_PROMPT_TEMPLATE } from '../copilot/planPromptTemplates';
import { useRunCommandStore, type RunCommandMap } from '../state/runCommandStore';
import { useNamedCommandStore, type NamedCommandMap } from '../state/namedCommandStore';
import { useKeybindingStore, type KeybindingMode } from '../state/keybindingStore';
import { useBuildStore, DEFAULT_DEBUG_LAUNCH_CONFIG } from '../state/buildStore';
import { parseProjectLaunchConfigurations, parseProjectTasks, useProjectTaskStore } from '../state/projectTaskStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useExtensionsStore, type InstalledExtension } from '../state/extensionsStore';
import { makeExtensionSettingsCategory, parseExtensionSettingsCategory } from '../extensions/extensionSettingsCategory';
import { ExtensionConfigFields } from './ExtensionConfigFields';
import './DiffViewModal.css';
import './PromptTemplateSettingsModal.css';
import './RunCommandSettingsModal.css';
import './SettingsModal.css';

type BuiltinSettingsCategory = 'keybinding' | 'buildAndDebug' | 'promptTemplates' | 'planTemplates' | 'runCommands' | 'namedCommands';
/** Built-in categories are fixed; an installed extension's own
 * `contributes.configuration` gets a dynamic category
 * (`ext:<extensionId>`, see extensionSettingsCategory.ts) added to the nav
 * at render time — widened to a plain string rather than a closed union
 * since the full set can't be known ahead of time (mirrors dockStore.ts's
 * PanelId widening for the same reason). */
export type SettingsCategory = BuiltinSettingsCategory | string;

const CATEGORY_LABELS: Record<BuiltinSettingsCategory, string> = {
  keybinding: 'キーバインド',
  buildAndDebug: 'ビルド・デバッグ',
  promptTemplates: '単発プロンプトテンプレート',
  planTemplates: '計画プロンプトテンプレート',
  runCommands: '拡張子ごとの実行コマンド',
  namedCommands: '名前付きコマンド',
};

/** Built-ins use the static table above; an extension's settings category
 * has no static label — shows the owning extension's displayName instead. */
function categoryLabel(id: SettingsCategory, extensions: InstalledExtension[]): string {
  const extId = parseExtensionSettingsCategory(id);
  if (!extId) return CATEGORY_LABELS[id as BuiltinSettingsCategory] ?? id;
  return extensions.find((e) => e.id === extId)?.displayName ?? extId;
}

// Grouped like VS Code's own nav (a bold group label over its category
// buttons) — keybinding and the run-command mappings are editor/workspace-
// wide preferences, not Copilot ones, so they sit under 一般; only the
// prompt-template settings are actually Copilot-specific.
const STATIC_NAV_GROUPS: { label: string; items: SettingsCategory[] }[] = [
  { label: '一般', items: ['keybinding', 'buildAndDebug', 'runCommands', 'namedCommands'] },
  { label: 'Copilot', items: ['promptTemplates', 'planTemplates'] },
];

interface RunCommandRow {
  id: string;
  ext: string;
  command: string;
}

function runCommandRowsToMap(rows: RunCommandRow[]): RunCommandMap {
  const map: RunCommandMap = {};
  for (const row of rows) {
    const ext = row.ext.trim().replace(/^\./, '').toLowerCase();
    if (ext && row.command.trim()) map[ext] = row.command.trim();
  }
  return map;
}

interface NamedCommandRow {
  id: string;
  name: string;
  command: string;
}

function namedCommandRowsToMap(rows: NamedCommandRow[]): NamedCommandMap {
  const map: NamedCommandMap = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name && row.command.trim()) map[name] = row.command.trim();
  }
  return map;
}

function defaultProjectTasksJson(buildCommand: string): string {
  return JSON.stringify({
    version: 1,
    tasks: buildCommand.trim() ? [{ id: 'build', label: 'ビルド', command: buildCommand.trim() }] : [],
  }, null, 2);
}

function defaultProjectLaunchJson(
  debugLaunchConfig: string,
  adapterCommand: string,
  adapterArgs: string,
  autoInstallDebugAdapter: boolean,
): string {
  let configuration: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(debugLaunchConfig);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) configuration = parsed as Record<string, unknown>;
  } catch {
    configuration = JSON.parse(DEFAULT_DEBUG_LAUNCH_CONFIG);
  }
  if (adapterCommand.trim()) configuration.adapterCommand = adapterCommand.trim();
  if (adapterArgs.trim()) configuration.adapterArgs = adapterArgs.trim();
  configuration.autoInstallDebugAdapter = autoInstallDebugAdapter;
  return JSON.stringify({ version: 1, configurations: [configuration] }, null, 2);
}

const AUTO_SAVE_DEBOUNCE_MS = 500;

/** Schedules `save` a beat after the last call (so a full textarea/list
 * write doesn't fire on every keystroke), while still exposing `flush` for
 * discrete actions (add/delete/reset) and for closing the modal — VS
 * Code's settings apply instantly with no explicit Save button, so nothing
 * here may be silently lost when the modal closes. Exported so
 * ExtensionSettingsModal.tsx can reuse the same auto-save UX instead of
 * re-implementing it. */
export function useDebouncedSave<T>(save: (value: T) => Promise<void>) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ value: T } | null>(null);

  function schedule(value: T) {
    pendingRef.current = { value };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) void save(pending.value);
    }, AUTO_SAVE_DEBOUNCE_MS);
  }

  function flush() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) void save(pending.value);
  }

  function now(value: T) {
    flush();
    void save(value);
  }

  return { schedule, flush, now };
}

// VS Code's Preferences → Settings shape: one window, a category list on
// the left, the selected category's content on the right, a search box to
// filter, and every change applies immediately — no Save/Cancel step.
export function SettingsModal({ initialCategory, onClose }: { initialCategory: SettingsCategory; onClose: () => void }) {
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const [search, setSearch] = useState('');
  const searchLower = search.trim().toLowerCase();

  const templates = usePromptTemplateStore((s) => s.templates);
  const saveTemplatesToStore = usePromptTemplateStore((s) => s.saveTemplates);
  const [promptDraft, setPromptDraft] = useState<PromptTemplateEntry[]>(templates);
  const [selectedTemplateId, setSelectedTemplateId] = useState(templates[0]?.id ?? '');
  const selectedTemplate = promptDraft.find((t) => t.id === selectedTemplateId);
  const promptSave = useDebouncedSave(saveTemplatesToStore);

  const planTemplate = usePlanPromptTemplateStore((s) => s.planTemplate);
  const stepTemplate = usePlanPromptTemplateStore((s) => s.stepTemplate);
  const savePlanTemplateToStore = usePlanPromptTemplateStore((s) => s.savePlanTemplate);
  const saveStepTemplateToStore = usePlanPromptTemplateStore((s) => s.saveStepTemplate);
  const [planDraft, setPlanDraft] = useState(planTemplate);
  const [stepDraft, setStepDraft] = useState(stepTemplate);
  const planSave = useDebouncedSave(savePlanTemplateToStore);
  const stepSave = useDebouncedSave(saveStepTemplateToStore);

  const runCommands = useRunCommandStore((s) => s.commands);
  const saveRunCommandsToStore = useRunCommandStore((s) => s.saveCommands);
  const [runCommandRows, setRunCommandRows] = useState<RunCommandRow[]>(() => {
    const initial = Object.entries(runCommands).map(([ext, command]) => ({ id: uuid(), ext, command }));
    return initial.length > 0 ? initial : [{ id: uuid(), ext: '', command: '' }];
  });
  const runCommandsSave = useDebouncedSave(saveRunCommandsToStore);

  const namedCommands = useNamedCommandStore((s) => s.commands);
  const saveNamedCommandsToStore = useNamedCommandStore((s) => s.saveCommands);
  const [namedCommandRows, setNamedCommandRows] = useState<NamedCommandRow[]>(() => {
    const initial = Object.entries(namedCommands).map(([name, command]) => ({ id: uuid(), name, command }));
    return initial.length > 0 ? initial : [{ id: uuid(), name: '', command: '' }];
  });
  const namedCommandsSave = useDebouncedSave(saveNamedCommandsToStore);

  const keybindingMode = useKeybindingStore((s) => s.mode);
  const setKeybindingMode = useKeybindingStore((s) => s.setMode);

  const buildCommand = useBuildStore((s) => s.buildCommand);
  const debugAdapterCommand = useBuildStore((s) => s.debugAdapterCommand);
  const debugAdapterArgs = useBuildStore((s) => s.debugAdapterArgs);
  const autoInstallDebugAdapter = useBuildStore((s) => s.autoInstallDebugAdapter);
  const debugLaunchConfig = useBuildStore((s) => s.debugLaunchConfig);
  const setBuildCommand = useBuildStore((s) => s.setBuildCommand);
  const setDebugAdapterCommand = useBuildStore((s) => s.setDebugAdapterCommand);
  const setDebugAdapterArgs = useBuildStore((s) => s.setDebugAdapterArgs);
  const setAutoInstallDebugAdapter = useBuildStore((s) => s.setAutoInstallDebugAdapter);
  const setDebugLaunchConfig = useBuildStore((s) => s.setDebugLaunchConfig);
  const saveBuildSettings = useBuildStore((s) => s.saveSettings);

  const rootHandle = useWorkspaceStore((s) => s.rootHandle);
  const projectTasksJson = useProjectTaskStore((s) => s.tasksJson);
  const projectLaunchJson = useProjectTaskStore((s) => s.launchJson);
  const projectSettingsLoaded = useProjectTaskStore((s) => s.loaded);
  const projectSettingsLoading = useProjectTaskStore((s) => s.loading);
  const projectSettingsSaving = useProjectTaskStore((s) => s.saving);
  const projectSettingsError = useProjectTaskStore((s) => s.errorMessage);
  const loadProjectSettings = useProjectTaskStore((s) => s.loadProjectSettings);
  const saveProjectSettings = useProjectTaskStore((s) => s.saveProjectSettings);
  const setProjectTasksJson = useProjectTaskStore((s) => s.setTasksJson);
  const setProjectLaunchJson = useProjectTaskStore((s) => s.setLaunchJson);
  const [projectSettingsDraftError, setProjectSettingsDraftError] = useState<string | null>(null);
  const projectSettingsSave = useDebouncedSave(async (value: { tasksJson: string; launchJson: string }) => {
    try {
      parseProjectTasks(value.tasksJson);
      parseProjectLaunchConfigurations(value.launchJson);
      await saveProjectSettings(value.tasksJson, value.launchJson);
      setProjectSettingsDraftError(null);
    } catch (error) {
      setProjectSettingsDraftError(error instanceof Error ? error.message : 'プロジェクト設定を保存できません。');
    }
  });

  useEffect(() => {
    void loadProjectSettings();
  }, [loadProjectSettings, rootHandle]);

  const installedExtensions = useExtensionsStore((s) => s.extensions);
  const extensionsWithSettings = useMemo(
    () => installedExtensions.filter((e) => e.configSchema.length > 0),
    [installedExtensions],
  );
  const navGroups = useMemo(() => {
    if (extensionsWithSettings.length === 0) return STATIC_NAV_GROUPS;
    return [
      ...STATIC_NAV_GROUPS,
      { label: '拡張機能', items: extensionsWithSettings.map((e) => makeExtensionSettingsCategory(e.id)) },
    ];
  }, [extensionsWithSettings]);

  function handleClose() {
    promptSave.flush();
    planSave.flush();
    stepSave.flush();
    runCommandsSave.flush();
    namedCommandsSave.flush();
    projectSettingsSave.flush();
    onClose();
  }

  function updateProjectSettings(next: { tasksJson: string; launchJson: string }) {
    setProjectTasksJson(next.tasksJson);
    setProjectLaunchJson(next.launchJson);
    try {
      parseProjectTasks(next.tasksJson);
      parseProjectLaunchConfigurations(next.launchJson);
      setProjectSettingsDraftError(null);
      projectSettingsSave.schedule(next);
    } catch (error) {
      setProjectSettingsDraftError(error instanceof Error ? error.message : 'JSONの形式を確認してください。');
    }
  }

  function initializeProjectSettings() {
    const next = {
      tasksJson: projectTasksJson.trim() ? projectTasksJson : defaultProjectTasksJson(buildCommand),
      launchJson: projectLaunchJson.trim() ? projectLaunchJson : defaultProjectLaunchJson(debugLaunchConfig, debugAdapterCommand, debugAdapterArgs, autoInstallDebugAdapter),
    };
    setProjectTasksJson(next.tasksJson);
    setProjectLaunchJson(next.launchJson);
    try {
      parseProjectTasks(next.tasksJson);
      parseProjectLaunchConfigurations(next.launchJson);
      setProjectSettingsDraftError(null);
      projectSettingsSave.now(next);
    } catch (error) {
      setProjectSettingsDraftError(error instanceof Error ? error.message : 'JSONの形式を確認してください。');
    }
  }

  function addRunCommandRow() {
    setRunCommandRows((prev) => [...prev, { id: uuid(), ext: '', command: '' }]);
  }

  function updateRunCommandRow(id: string, patch: Partial<RunCommandRow>) {
    const next = runCommandRows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    setRunCommandRows(next);
    runCommandsSave.schedule(runCommandRowsToMap(next));
  }

  function removeRunCommandRow(id: string) {
    const next = runCommandRows.filter((r) => r.id !== id);
    setRunCommandRows(next);
    runCommandsSave.now(runCommandRowsToMap(next));
  }

  function addNamedCommandRow() {
    setNamedCommandRows((prev) => [...prev, { id: uuid(), name: '', command: '' }]);
  }

  function updateNamedCommandRow(id: string, patch: Partial<NamedCommandRow>) {
    const next = namedCommandRows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    setNamedCommandRows(next);
    namedCommandsSave.schedule(namedCommandRowsToMap(next));
  }

  function removeNamedCommandRow(id: string) {
    const next = namedCommandRows.filter((r) => r.id !== id);
    setNamedCommandRows(next);
    namedCommandsSave.now(namedCommandRowsToMap(next));
  }

  function handleSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
    }
  }

  const visibleNavGroups = searchLower
    ? navGroups
        .map((g) => ({
          ...g,
          items: g.items.filter((id) => categoryLabel(id, installedExtensions).toLowerCase().includes(searchLower)),
        }))
        .filter((g) => g.items.length > 0)
    : navGroups;
  const visibleCategoryIds = visibleNavGroups.flatMap((g) => g.items);
  useEffect(() => {
    if (visibleCategoryIds.length > 0 && !visibleCategoryIds.includes(category)) {
      setCategory(visibleCategoryIds[0]);
    }
    // Only re-run when the filtered set changes shape, not on every
    // unrelated render (category switches deliberately don't re-trigger
    // this — the user picking a category by hand should never be
    // overridden by this effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchLower]);

  const visibleTemplates = searchLower
    ? promptDraft.filter((t) => t.name.toLowerCase().includes(searchLower))
    : promptDraft;

  function updateSelectedTemplate(patch: Partial<PromptTemplateEntry>) {
    const next = promptDraft.map((t) => (t.id === selectedTemplateId ? { ...t, ...patch } : t));
    setPromptDraft(next);
    promptSave.schedule(next);
  }

  function addTemplate() {
    const entry = newPromptTemplateEntry();
    const next = [...promptDraft, entry];
    setPromptDraft(next);
    setSelectedTemplateId(entry.id);
    promptSave.now(next);
  }

  function deleteTemplate(id: string) {
    const next = promptDraft.filter((t) => t.id !== id);
    setPromptDraft(next);
    if (selectedTemplateId === id) setSelectedTemplateId(next[0]?.id ?? '');
    promptSave.now(next);
  }

  function resetPlanDraft() {
    setPlanDraft(DEFAULT_PLAN_PROMPT_TEMPLATE);
    planSave.now(DEFAULT_PLAN_PROMPT_TEMPLATE);
  }

  function resetStepDraft() {
    setStepDraft(DEFAULT_STEP_PROMPT_TEMPLATE);
    stepSave.now(DEFAULT_STEP_PROMPT_TEMPLATE);
  }

  return (
    <div className="diff-modal-overlay" onClick={handleClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-header">
          <span className="settings-modal-title">設定</span>
          <button className="settings-modal-close-btn" onClick={handleClose} title="閉じる (Esc)">
            ×
          </button>
        </div>
        <div className="settings-search-row">
          <input
            className="settings-search-input"
            placeholder="設定を検索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            autoFocus
          />
        </div>
        <div className="settings-modal-body">
          <div className="settings-nav">
            {visibleNavGroups.map((group) => (
              <div key={group.label}>
                <div className="settings-nav-group-label">{group.label}</div>
                {group.items.map((id) => (
                  <button
                    key={id}
                    className={`settings-nav-item ${category === id ? 'active' : ''}`}
                    onClick={() => setCategory(id)}
                  >
                    {categoryLabel(id, installedExtensions)}
                  </button>
                ))}
              </div>
            ))}
            {visibleNavGroups.length === 0 && (
              <div className="settings-nav-empty">一致する項目がありません</div>
            )}
          </div>
          <div className="settings-content">
            <div className="prompt-template-body" style={{ display: category === 'keybinding' ? 'flex' : 'none' }}>
              <div className="settings-row">
                <div className="settings-row-label">キーバインド</div>
                <p className="settings-row-description">エディタのキー操作方式を選択します。</p>
                <select
                  className="settings-select"
                  value={keybindingMode}
                  onChange={(e) => void setKeybindingMode(e.target.value as KeybindingMode)}
                >
                  <option value="default">デフォルト</option>
                  <option value="vim">Vim</option>
                  <option value="emacs">Emacs</option>
                </select>
              </div>
            </div>
            <div className="prompt-template-body settings-build-body" style={{ display: category === 'buildAndDebug' ? 'flex' : 'none' }}>
              <div className="settings-row">
                <div className="settings-row-label">ビルド・デバッグ設定</div>
                <p className="settings-row-description">
                  プロジェクト設定がある場合は、tasks.jsonのbuild/runタスクとlaunch.jsonの先頭の構成が優先されます。JSONを変更すると自動的にワークスペースへ保存されます。
                </p>
                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={autoInstallDebugAdapter}
                    onChange={(e) => {
                      setAutoInstallDebugAdapter(e.target.checked);
                      void saveBuildSettings();
                    }}
                  />
                  launch.jsonにアダプター指定がない場合はDAPアダプターを自動導入する
                </label>
              </div>

              <div className="settings-row">
                <div className="settings-row-label">ローカルのフォールバック設定</div>
                <p className="settings-row-description">プロジェクト設定に該当項目がない場合に使用されます。</p>
                <input className="settings-text-input" value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} onBlur={() => void saveBuildSettings()} placeholder="ビルドコマンド (例: npm run build)" />
                <input className="settings-text-input" value={debugAdapterCommand} onChange={(e) => setDebugAdapterCommand(e.target.value)} onBlur={() => void saveBuildSettings()} placeholder="DAPアダプター (例: python)" />
                <input className="settings-text-input" value={debugAdapterArgs} onChange={(e) => setDebugAdapterArgs(e.target.value)} onBlur={() => void saveBuildSettings()} placeholder={'アダプター引数 (例: ["-m", "debugpy.adapter"])'} />
                <textarea className="settings-json-textarea" value={debugLaunchConfig} onChange={(e) => setDebugLaunchConfig(e.target.value)} onBlur={() => void saveBuildSettings()} rows={3} placeholder="起動設定JSON" />
              </div>

              <div className="settings-row">
                <div className="settings-row-label-with-action">
                  <span className="settings-row-label">プロジェクト設定</span>
                  <button className="settings-reset-btn" onClick={initializeProjectSettings} disabled={!rootHandle}>未設定なら初期化して保存</button>
                </div>
                <p className="settings-row-description">
                  保存先: .m365ce/tasks.json / .m365ce/launch.json。{projectSettingsLoading ? '読み込み中...' : projectSettingsLoaded ? '読み込み済み' : '未読み込み'}
                </p>
                <label className="settings-json-label">
                  tasks.json
                  <textarea className="settings-json-textarea settings-project-json" value={projectTasksJson} onChange={(e) => updateProjectSettings({ tasksJson: e.target.value, launchJson: projectLaunchJson })} rows={9} spellCheck={false} placeholder={'{"version":1,"tasks":[{"id":"build","label":"ビルド","command":"npm run build"}]}' } />
                </label>
                <label className="settings-json-label">
                  launch.json
                  <textarea className="settings-json-textarea settings-project-json" value={projectLaunchJson} onChange={(e) => updateProjectSettings({ tasksJson: projectTasksJson, launchJson: e.target.value })} rows={11} spellCheck={false} placeholder={'{"version":1,"configurations":[{"name":"現在のファイル","type":"pwa-node","request":"launch","program":"{file}","cwd":"{workspace}"}]}' } />
                </label>
                <div className="settings-save-status">{projectSettingsSaving ? '保存中...' : projectSettingsLoaded ? '変更は自動保存されます' : ''}</div>
                {(projectSettingsDraftError || projectSettingsError) && <div className="settings-error">{projectSettingsDraftError || projectSettingsError}</div>}
              </div>
            </div>
            <div className="prompt-template-split" style={{ display: category === 'promptTemplates' ? 'flex' : 'none' }}>
              <div className="prompt-template-list">
                {visibleTemplates.map((t) => (
                  <div
                    key={t.id}
                    className={`prompt-template-list-item ${t.id === selectedTemplateId ? 'active' : ''}`}
                    onClick={() => setSelectedTemplateId(t.id)}
                  >
                    <span className="prompt-template-list-name">{t.name || '(名称未設定)'}</span>
                    <button
                      className="prompt-template-list-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteTemplate(t.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {visibleTemplates.length === 0 && (
                  <div className="settings-nav-empty">一致するテンプレートがありません</div>
                )}
                <button className="prompt-template-add-btn" onClick={addTemplate}>
                  + 新規テンプレート
                </button>
              </div>
              <div className="prompt-template-editor">
                {selectedTemplate ? (
                  <>
                    <div className="settings-row">
                      <div className="settings-row-label">名前</div>
                      <input
                        className="prompt-template-name-input"
                        value={selectedTemplate.name}
                        onChange={(e) => updateSelectedTemplate({ name: e.target.value })}
                        placeholder="テンプレート名(例: コード解析・説明)"
                      />
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-label">テンプレート本文</div>
                      <p className="settings-row-description">
                        利用できるプレースホルダー: {'{instruction}'}(指示欄の内容) / {'{filesSection}'}
                        (選択したコンテキストファイルの中身。0件なら空文字) / {'{fileInstructionSection}'}
                        (「変更後のファイル全体をコードブロックで返す」指示。ファイルが1件以上ある場合のみ展開 —
                        解析・説明用途では省略してよい) / {'{repoMapSection}'}
                        (「リポジトリ構成を含める」を有効にした場合のみ展開)
                      </p>
                      <textarea
                        className="prompt-template-textarea"
                        value={selectedTemplate.template}
                        onChange={(e) => updateSelectedTemplate({ template: e.target.value })}
                        spellCheck={false}
                      />
                    </div>
                  </>
                ) : (
                  <div className="prompt-template-hint">テンプレートがありません。「+ 新規テンプレート」から追加してください。</div>
                )}
              </div>
            </div>
            <div className="prompt-template-body" style={{ display: category === 'planTemplates' ? 'flex' : 'none' }}>
              <div className="settings-row">
                <div className="settings-row-label-with-action">
                  <span className="settings-row-label">① 計画作成プロンプト</span>
                  <button className="settings-reset-btn" onClick={resetPlanDraft} title="既定値に戻す">
                    ⟲ 既定値に戻す
                  </button>
                </div>
                <p className="settings-row-description">
                  プレースホルダー: {'{goal}'}(目標) / {'{repoMapSection}'}(repomap、有効時のみ展開) /{' '}
                  {'{contextFilesSection}'}(追加したコンテキストファイル、あれば展開)
                </p>
                <textarea
                  className="prompt-template-textarea"
                  value={planDraft}
                  onChange={(e) => {
                    setPlanDraft(e.target.value);
                    planSave.schedule(e.target.value);
                  }}
                  spellCheck={false}
                />
              </div>

              <div className="settings-row">
                <div className="settings-row-label-with-action">
                  <span className="settings-row-label">② ステップ実行プロンプト</span>
                  <button className="settings-reset-btn" onClick={resetStepDraft} title="既定値に戻す">
                    ⟲ 既定値に戻す
                  </button>
                </div>
                <p className="settings-row-description">
                  プレースホルダー: {'{goal}'}(目標) / {'{planSection}'}(計画全体の一覧) /{' '}
                  {'{stepDescription}'}(今回実行するステップの説明) / {'{stepFilesSection}'}
                  (該当ステップの関連ファイルの現在の内容)
                </p>
                <textarea
                  className="prompt-template-textarea"
                  value={stepDraft}
                  onChange={(e) => {
                    setStepDraft(e.target.value);
                    stepSave.schedule(e.target.value);
                  }}
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="prompt-template-body" style={{ display: category === 'runCommands' ? 'flex' : 'none' }}>
              <div className="settings-row">
                <div className="settings-row-label">拡張子ごとの実行コマンド</div>
                <p className="settings-row-description">
                  {'{file}'} は開いているファイルの、ワークスペースルートからの相対パスに置き換わります(terminal-hostの起動ディレクトリ=ワークスペースルートである前提)。
                  例: 拡張子「py」/ コマンド「python {'{file}'}」。
                  未設定の拡張子は実行ボタンが表示されません(デフォルトは実行なし)。
                </p>
                {runCommandRows.map((row) => (
                  <div key={row.id} className="run-settings-row">
                    <input
                      className="run-settings-ext-input"
                      placeholder="拡張子 (例: py)"
                      value={row.ext}
                      onChange={(e) => updateRunCommandRow(row.id, { ext: e.target.value })}
                    />
                    <input
                      className="run-settings-command-input"
                      placeholder="コマンド (例: python {file})"
                      value={row.command}
                      onChange={(e) => updateRunCommandRow(row.id, { command: e.target.value })}
                    />
                    <button onClick={() => removeRunCommandRow(row.id)}>削除</button>
                  </div>
                ))}
                <button className="prompt-template-add-btn" onClick={addRunCommandRow}>
                  + 追加
                </button>
              </div>
            </div>
            <div className="prompt-template-body" style={{ display: category === 'namedCommands' ? 'flex' : 'none' }}>
              <div className="settings-row">
                <div className="settings-row-label">名前付きコマンド</div>
                <p className="settings-row-description">
                  特定のファイルに紐づかないプロジェクト単位のコマンド(テストの実行・git diffの確認など)を、名前を付けて登録しておけます。
                  Copilotが `TOOL_RUN_NAMED: 名前` の形式で実行をリクエストした場合、ここで登録した名前と一致すればそのコマンドの実行を確認できます。
                  例: 名前「test」/ コマンド「npm test」。
                </p>
                {namedCommandRows.map((row) => (
                  <div key={row.id} className="run-settings-row">
                    <input
                      className="run-settings-ext-input"
                      placeholder="名前 (例: test)"
                      value={row.name}
                      onChange={(e) => updateNamedCommandRow(row.id, { name: e.target.value })}
                    />
                    <input
                      className="run-settings-command-input"
                      placeholder="コマンド (例: npm test)"
                      value={row.command}
                      onChange={(e) => updateNamedCommandRow(row.id, { command: e.target.value })}
                    />
                    <button onClick={() => removeNamedCommandRow(row.id)}>削除</button>
                  </div>
                ))}
                <button className="prompt-template-add-btn" onClick={addNamedCommandRow}>
                  + 追加
                </button>
              </div>
            </div>
            {extensionsWithSettings.map((ext) => (
              <div
                key={ext.id}
                className="prompt-template-body"
                style={{ display: category === makeExtensionSettingsCategory(ext.id) ? 'flex' : 'none' }}
              >
                <ExtensionConfigFields extension={ext} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
