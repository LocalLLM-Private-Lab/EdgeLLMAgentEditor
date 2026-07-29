import { useState, type ReactNode } from 'react';
import type { InstalledExtension, ConfigPropertySchema } from '../state/extensionsStore';
import { useExtensionsStore } from '../state/extensionsStore';
import { updateExtensionConfig } from '../extensions/extensionHostClient';
import { MarkdownDescription } from './MarkdownDescription';
import { useDebouncedSave } from './SettingsModal';
import './ExtensionConfigFields.css';

type FieldKind = 'boolean' | 'enum' | 'string' | 'number' | 'stringArray' | 'json';

function fieldKind(schema: ConfigPropertySchema): FieldKind {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'boolean') return 'boolean';
  if (schema.enum && schema.enum.length > 0) return 'enum';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'array' && schema.items?.type === 'string') return 'stringArray';
  if (type === 'string') return 'string';
  return 'json';
}

// Strips the extension's own namespace prefix (e.g. "localLlm.") and turns
// the rest into a lightweight breadcrumb — purely cosmetic, the real key
// (shown in the field's title attribute) is what actually gets saved.
function fieldLabel(key: string): string {
  const parts = key.split('.');
  return parts.length > 1 ? parts.slice(1).join(' › ') : key;
}

function stringifyArray(value: unknown): string {
  return Array.isArray(value) ? value.join('\n') : '';
}

function parseArray(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface ConfigFieldProps {
  extensionId: string;
  schema: ConfigPropertySchema;
  value: unknown;
  active: boolean;
}

function ConfigField({ extensionId, schema, value, active }: ConfigFieldProps) {
  const kind = fieldKind(schema);
  const debounced = useDebouncedSave<unknown>((v) => updateExtensionConfig(extensionId, schema.key, v));
  const [jsonError, setJsonError] = useState<string | null>(null);
  // Local draft text for free-typing fields — deliberately NOT re-synced
  // from the store on every render (only seeded once at mount): the store
  // only reflects a save ~500ms after the last keystroke, so binding the
  // input directly to it would fight the user's typing (each keystroke
  // getting overwritten back to the stale committed value).
  const [textDraft, setTextDraft] = useState(() => {
    if (kind === 'stringArray') return stringifyArray(value);
    if (kind === 'json') return JSON.stringify(value ?? schema.default ?? null, null, 2);
    return value === undefined || value === null ? '' : String(value);
  });

  function resetToDefault() {
    if (kind === 'stringArray') setTextDraft(stringifyArray(schema.default));
    else if (kind === 'json') setTextDraft(JSON.stringify(schema.default ?? null, null, 2));
    else setTextDraft(schema.default === undefined || schema.default === null ? '' : String(schema.default));
    setJsonError(null);
    debounced.now(schema.default);
  }

  let control: ReactNode;
  if (kind === 'boolean') {
    control = (
      <label className="ext-settings-checkbox-row">
        <input
          type="checkbox"
          checked={Boolean(value ?? schema.default)}
          onChange={(e) => debounced.now(e.target.checked)}
        />
        <span>{fieldLabel(schema.key)}</span>
      </label>
    );
  } else if (kind === 'enum') {
    const current = String(value ?? schema.default ?? '');
    const descIndex = schema.enum?.indexOf(current) ?? -1;
    const enumDescription = descIndex >= 0 ? schema.enumDescriptions?.[descIndex] : undefined;
    control = (
      <>
        <select className="settings-select" value={current} onChange={(e) => debounced.now(e.target.value)}>
          {schema.enum?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {enumDescription && <p className="settings-row-description">{enumDescription}</p>}
      </>
    );
  } else if (kind === 'number') {
    control = (
      <input
        type="number"
        className="ext-settings-input"
        value={textDraft}
        onChange={(e) => {
          setTextDraft(e.target.value);
          const parsed = Number(e.target.value);
          if (!Number.isNaN(parsed)) debounced.schedule(parsed);
        }}
        onBlur={debounced.flush}
      />
    );
  } else if (kind === 'stringArray') {
    control = (
      <textarea
        className="ext-settings-textarea"
        rows={4}
        placeholder="1行に1項目"
        value={textDraft}
        onChange={(e) => {
          setTextDraft(e.target.value);
          debounced.schedule(parseArray(e.target.value));
        }}
        onBlur={debounced.flush}
      />
    );
  } else if (kind === 'json') {
    control = (
      <>
        <textarea
          className="ext-settings-textarea ext-settings-textarea-json"
          rows={5}
          value={textDraft}
          onChange={(e) => {
            setTextDraft(e.target.value);
            try {
              const parsed = JSON.parse(e.target.value) as unknown;
              setJsonError(null);
              debounced.schedule(parsed);
            } catch {
              setJsonError('JSONとして解析できません(この内容は保存されません)。');
            }
          }}
          onBlur={debounced.flush}
        />
        {jsonError && <p className="ext-settings-json-error">{jsonError}</p>}
      </>
    );
  } else {
    control = (
      <input
        type="text"
        className="ext-settings-input"
        value={textDraft}
        onChange={(e) => {
          setTextDraft(e.target.value);
          debounced.schedule(e.target.value);
        }}
        onBlur={debounced.flush}
      />
    );
  }

  return (
    <div className="settings-row" title={schema.key}>
      <div className="settings-row-label-with-action">
        {kind !== 'boolean' && <span className="settings-row-label">{fieldLabel(schema.key)}</span>}
        <button className="settings-reset-btn" onClick={resetToDefault} title="既定値に戻す">
          既定値に戻す
        </button>
      </div>
      {schema.description ? (
        <p className="settings-row-description">{schema.description}</p>
      ) : schema.markdownDescription ? (
        <MarkdownDescription text={schema.markdownDescription} extensionId={extensionId} active={active} />
      ) : null}
      {control}
    </div>
  );
}

// Stable fallback reference — a `?? {}` literal directly in the selector
// below would construct a brand-new object every call, failing Zustand's
// default reference-equality check on every render and causing an
// infinite re-render loop (React error #185, hit this for real; see
// WebviewHost's older fix for the same class of bug).
const EMPTY_CONFIG: Record<string, unknown> = {};

/** One extension's `contributes.configuration` fields — rendered inline
 * inside SettingsModal.tsx's content pane (as its own dynamic nav
 * category, see extensionSettingsCategory.ts) rather than its own modal.
 * Values persist to chrome.storage immediately (same debounced-autosave
 * UX as every other settings category, no explicit Save button) and, when
 * the extension is currently active, are pushed live into the running
 * host process too. Command links inside markdownDescription only work
 * while active (see MarkdownDescription.tsx). */
export function ExtensionConfigFields({ extension }: { extension: InstalledExtension }) {
  const configValues = useExtensionsStore((s) => s.configValues[extension.id] ?? EMPTY_CONFIG);
  const active = useExtensionsStore((s) => s.status[extension.id]?.kind === 'active');

  if (extension.configSchema.length === 0) {
    return <p className="settings-row-description">この拡張機能には設定項目がありません。</p>;
  }

  // No wrapper of its own — the caller (SettingsModal.tsx) supplies the
  // same `.prompt-template-body` padding/scroll container every other
  // category uses, so this slots in identically regardless of which
  // category is currently selected.
  return (
    <>
      {extension.configSchema.map((schema) => (
        <ConfigField
          key={schema.key}
          extensionId={extension.id}
          schema={schema}
          value={configValues[schema.key]}
          active={active}
        />
      ))}
    </>
  );
}
