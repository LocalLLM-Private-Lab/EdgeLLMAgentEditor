import * as monaco from 'monaco-editor';
import { create } from 'zustand';
import { LspWsClient } from './lspWsClient';
import type { ServerMessage } from './lspProtocol';
import { launchLspHostViaNativeMessaging } from './lspNativeLaunch';
import { isLspLanguage } from './lspLanguages';
import { type LspRange, lspRangeToMonaco, normalizeUriKey } from './uriTranslation';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';
import { useWorkspaceStore } from '../state/workspaceStore';

export type LspStatus =
  | 'idle'
  | 'connecting'
  | 'fetching'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'error';

const WORKSPACE_ROOT_STORAGE_KEY = 'lspWorkspaceRootOverride';

interface LspState {
  status: LspStatus;
  fetchProgress: { downloaded: number; total: number | null } | null;
  installLanguage: string | null;
  installMessage: string | null;
  indexing: boolean;
  indexingLanguage: string | null;
  indexingMessage: string | null;
  indexingProgress: number | null;
  errorMessage: string | null;
  rootUri: string | null;
  serverVersion: string | null;
  /** Language whose initialize handshake most recently completed. */
  readyLanguage: string | null;
  /** Absolute filesystem path explicitly selected as the language-server
   * workspace root. Null means the host chooses its launch directory. */
  workspaceRootOverride: string | null;
  loadWorkspaceRootOverride: () => Promise<void>;
  setWorkspaceRootOverride: (path: string | null) => Promise<void>;
  /** Ensures the shared WebSocket and the requested language server session
   * are ready. The default keeps existing callers Rust-compatible. */
  ensureSession: (language?: string) => Promise<void>;
  registerDocument: (uri: string, model: monaco.editor.ITextModel, languageId: string) => void;
  unregisterDocument: (uri: string) => void;
  notifyDidChange: (uri: string, languageId: string) => void;
  requestDefinition: (language: string, uri: string, position: { line: number; character: number }) => Promise<unknown>;
  requestDeclaration: (language: string, uri: string, position: { line: number; character: number }) => Promise<unknown>;
  requestImplementation: (
    language: string,
    uri: string,
    position: { line: number; character: number },
  ) => Promise<unknown>;
  requestTypeDefinition: (
    language: string,
    uri: string,
    position: { line: number; character: number },
  ) => Promise<unknown>;
  requestReferences: (
    language: string,
    uri: string,
    position: { line: number; character: number },
    includeDeclaration: boolean,
  ) => Promise<unknown>;
  requestDocumentSymbols: (language: string, uri: string) => Promise<unknown>;
  requestCompletion: (
    language: string,
    uri: string,
    position: { line: number; character: number },
    context: { triggerKind: number; triggerCharacter?: string },
  ) => Promise<unknown>;
  requestSignatureHelp: (
    language: string,
    uri: string,
    position: { line: number; character: number },
  ) => Promise<unknown>;
  requestHover: (language: string, uri: string, position: { line: number; character: number }) => Promise<unknown>;
  /** Reads an arbitrary file by its `file://` URI via lsp-host's own
   * filesystem access — for definition/hover targets outside the browser's
   * FSA-granted workspace (e.g. Rust/Python standard library source). See
   * uriToPathSegments's doc comment for why the browser can't just open
   * these itself. */
  requestFileContent: (uri: string) => Promise<string>;
}

// The WebSocket is shared, while each language gets an independent server
// process and initialize handshake. This permits mixed-language projects.
let client: LspWsClient | null = null;
let connectionPromise: Promise<void> | null = null;
let connectionDeferred: { resolve: () => void; reject: (err: Error) => void } | null = null;
const sessionPromises = new Map<string, Promise<void>>();
const sessionDeferreds = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
const initializedLanguages = new Set<string>();
const activeLanguages = new Set<string>();
let nextRequestId = 1;
const pendingRequests = new Map<
  number,
  { language: string; method: string; resolve: (value: unknown) => void; reject: (err: Error) => void }
>();
const pendingFileReads = new Map<number, { resolve: (content: string) => void; reject: (err: Error) => void }>();
let rustBuildScriptsDisabled = false;
const rustFallbackRestarting = new Set<string>();
const indexingLanguages = new Set<string>();
const indexingTokens = new Map<string, Set<string>>();
const indexingMessages = new Map<string, { message: string; progress: number | null }>();
const indexingFinishTimers = new Map<string, ReturnType<typeof setTimeout>>();
const indexingFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

const INDEXING_SETTLE_MS = 500;
// Some language servers initialize successfully without emitting a standard
// progress notification. Keep the common indicator useful without leaving it
// stuck forever in that case.
const INDEXING_FALLBACK_MS = 5000;

interface TrackedDocument {
  uri: string;
  model: monaco.editor.ITextModel;
  languageId: string;
}
const trackedDocuments = new Map<string, TrackedDocument>();
const documentVersions = new Map<string, number>();
const changeTimers = new Map<string, ReturnType<typeof setTimeout>>();

const CHANGE_DEBOUNCE_MS = 300;

function clearIndexingLanguage(language: string): void {
  indexingLanguages.delete(language);
  indexingTokens.delete(language);
  indexingMessages.delete(language);
  const finishTimer = indexingFinishTimers.get(language);
  if (finishTimer) clearTimeout(finishTimer);
  indexingFinishTimers.delete(language);
  const fallbackTimer = indexingFallbackTimers.get(language);
  if (fallbackTimer) clearTimeout(fallbackTimer);
  indexingFallbackTimers.delete(language);
}

function resetIndexingTracking(): void {
  for (const timer of indexingFinishTimers.values()) clearTimeout(timer);
  for (const timer of indexingFallbackTimers.values()) clearTimeout(timer);
  indexingLanguages.clear();
  indexingTokens.clear();
  indexingMessages.clear();
  indexingFinishTimers.clear();
  indexingFallbackTimers.clear();
}

function publishIndexingState(set: (partial: Partial<LspState>) => void): void {
  const language = indexingLanguages.values().next().value as string | undefined;
  const detail = language ? indexingMessages.get(language) : undefined;
  set({
    indexing: indexingLanguages.size > 0,
    indexingLanguage: language ?? null,
    indexingMessage: detail?.message ?? null,
    indexingProgress: detail?.progress ?? null,
  });
}

function markIndexingUsable(language: string, set: (partial: Partial<LspState>) => void): void {
  if (!indexingLanguages.has(language)) return;
  clearIndexingLanguage(language);
  publishIndexingState(set);
}

function beginIndexing(language: string, set: (partial: Partial<LspState>) => void): void {
  clearIndexingLanguage(language);
  indexingLanguages.add(language);
  indexingTokens.set(language, new Set());
  indexingMessages.set(language, { message: 'Analyzing workspace...', progress: null });
  if (language !== 'rust') {
    indexingFallbackTimers.set(
      language,
      setTimeout(() => {
        indexingFallbackTimers.delete(language);
        if ((indexingTokens.get(language)?.size ?? 0) === 0) {
          clearIndexingLanguage(language);
          publishIndexingState(set);
        }
      }, INDEXING_FALLBACK_MS),
    );
  }
  publishIndexingState(set);
}

function finishIndexingWhenIdle(language: string, set: (partial: Partial<LspState>) => void): void {
  // rust-analyzer's progress phases can end before its analyzer is actually
  // quiescent. Its server-status notification is the authoritative signal.
  if (language === 'rust') return;
  const tokens = indexingTokens.get(language);
  if (!tokens || tokens.size > 0) return;
  const existingTimer = indexingFinishTimers.get(language);
  if (existingTimer) clearTimeout(existingTimer);
  indexingFinishTimers.set(
    language,
    setTimeout(() => {
      indexingFinishTimers.delete(language);
      if ((indexingTokens.get(language)?.size ?? 0) > 0) return;
      clearIndexingLanguage(language);
      publishIndexingState(set);
    }, INDEXING_SETTLE_MS),
  );
}

function handleRustServerStatus(params: unknown, set: (partial: Partial<LspState>) => void): void {
  if (typeof params !== 'object' || params === null) return;
  const status = params as { health?: unknown; quiescent?: unknown; message?: unknown };
  if (typeof status.quiescent !== 'boolean') return;

  if (status.health === 'ok' && status.quiescent) {
    clearIndexingLanguage('rust');
    publishIndexingState(set);
    return;
  }

  if (!indexingLanguages.has('rust')) {
    indexingLanguages.add('rust');
    indexingTokens.set('rust', new Set());
  }
  const fallbackTimer = indexingFallbackTimers.get('rust');
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    indexingFallbackTimers.delete('rust');
  }
  indexingMessages.set('rust', {
    message: typeof status.message === 'string' ? status.message : 'Analyzing workspace...',
    progress: null,
  });
  publishIndexingState(set);
}

function handleProgress(params: unknown, language: string, set: (partial: Partial<LspState>) => void): void {
  if (typeof params !== 'object' || params === null) return;
  const progress = params as { token?: unknown; value?: unknown };
  const token =
    typeof progress.token === 'string' || typeof progress.token === 'number'
      ? String(progress.token)
      : null;
  if (!token || typeof progress.value !== 'object' || progress.value === null) return;
  const value = progress.value as {
    kind?: unknown;
    title?: unknown;
    message?: unknown;
    percentage?: unknown;
  };
  const kind = value.kind;
  if (kind === 'begin' || kind === 'report') {
    if (!indexingLanguages.has(language)) {
      indexingLanguages.add(language);
      indexingTokens.set(language, new Set());
    }
    indexingTokens.get(language)?.add(token);
    const fallbackTimer = indexingFallbackTimers.get(language);
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      indexingFallbackTimers.delete(language);
    }
    const currentMessage = indexingMessages.get(language);
    indexingMessages.set(language, {
      message:
        typeof value.message === 'string'
          ? value.message
          : typeof value.title === 'string'
            ? value.title
            : currentMessage?.message ?? 'Analyzing workspace...',
      progress:
        typeof value.percentage === 'number' ? Math.max(0, Math.min(100, value.percentage)) : null,
    });
    publishIndexingState(set);
  } else if (kind === 'end') {
    indexingTokens.get(language)?.delete(token);
    finishIndexingWhenIdle(language, set);
  }
}

const SEVERITY_MAP: Record<number, monaco.MarkerSeverity> = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint,
};

export function getUriForModel(model: monaco.editor.ITextModel): string | null {
  for (const doc of trackedDocuments.values()) {
    if (doc.model === model) return doc.uri;
  }
  return null;
}

function sendRequest(language: string, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!client) {
      reject(new Error('LSP session is not connected'));
      return;
    }
    const id = nextRequestId++;
    pendingRequests.set(id, { language, method, resolve, reject });
    client.send({ type: 'lsp', language, payload: { jsonrpc: '2.0', id, method, params } });
  });
}

function sendNotification(language: string, method: string, params: unknown): void {
  client?.send({ type: 'lsp', language, payload: { jsonrpc: '2.0', method, params } });
}

function requestFileContentImpl(uri: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!client) {
      reject(new Error('LSP session is not connected'));
      return;
    }
    const id = nextRequestId++;
    pendingFileReads.set(id, { resolve, reject });
    client.send({ type: 'read_file', id, uri });
  });
}

interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Array<{ range: LspRange; severity?: number; message: string }>;
}

function applyDiagnostics(language: string, params: PublishDiagnosticsParams): void {
  const doc = trackedDocuments.get(normalizeUriKey(params.uri));
  if (!doc) return;
  const markers: monaco.editor.IMarkerData[] = params.diagnostics.map((d) => ({
    ...lspRangeToMonaco(d.range),
    message: d.message,
    severity: SEVERITY_MAP[d.severity ?? 1] ?? monaco.MarkerSeverity.Error,
  }));
  monaco.editor.setModelMarkers(doc.model, `lsp-${language}`, markers);
}

function fileUriToPath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return null;
    let path = decodeURIComponent(parsed.pathname);
    // URL pathname for a Windows drive is `/C:/...`; Pyright expects `C:/...`.
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return path;
  } catch {
    return null;
  }
}

function pythonServerSettings(rootUri: string, pythonVenv: string | null): Record<string, unknown> {
  const analysis: Record<string, unknown> = {
    autoSearchPaths: true,
    diagnosticMode: 'workspace',
    useLibraryCodeForTypes: true,
  };
  const rootPath = fileUriToPath(rootUri);
  if (rootPath && pythonVenv) {
    // Pyright reads venvPath/venv from its language-server settings when a
    // project config does not provide them. Project pyrightconfig.json or
    // pyproject.toml remains authoritative when present.
    analysis.venvPath = rootPath;
    analysis.venv = pythonVenv;
  }
  return { python: { analysis } };
}

async function performInitialize(
  language: string,
  rootUri: string,
  set: (partial: Partial<LspState>) => void,
  pythonVenv: string | null,
): Promise<void> {
  try {
    const pythonSettings = language === 'python' ? pythonServerSettings(rootUri, pythonVenv) : null;
    const result = (await sendRequest(language, 'initialize', {
      processId: null,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
      ...(language === 'rust' && rustBuildScriptsDisabled
        ? {
            // Avoid rust-analyzer's build-script worker for environments
            // affected by the run_build_scripts crash.
            initializationOptions: {
              cargo: {
                buildScripts: {
                  enable: false,
                },
              },
            },
          }
        : {}),
      ...(pythonSettings ? { initializationOptions: { settings: pythonSettings } } : {}),
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          completion: {
            completionItem: {
              snippetSupport: true,
              commitCharactersSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
              deprecatedSupport: true,
              preselectSupport: true,
              tagSupport: { valueSet: [1] },
            },
          },
          definition: { linkSupport: false },
          declaration: { linkSupport: false },
          implementation: { linkSupport: false },
          typeDefinition: { linkSupport: false },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          signatureHelp: {
            signatureInformation: {
              documentationFormat: ['markdown', 'plaintext'],
              parameterInformation: { labelOffsetSupport: true },
            },
          },
          hover: { contentFormat: ['plaintext', 'markdown'] },
          publishDiagnostics: { relatedInformation: false },
        },
        window: { workDoneProgress: true },
        ...(language === 'rust' ? { experimental: { serverStatusNotification: true } } : {}),
      },
    })) as { serverInfo?: { version?: string } } | undefined;
    sendNotification(language, 'initialized', {});
    if (pythonSettings) {
      sendNotification(language, 'workspace/didChangeConfiguration', { settings: pythonSettings });
    }
    initializedLanguages.add(language);
    rustFallbackRestarting.delete(language);
    set({
      status: 'ready',
      readyLanguage: language,
      serverVersion: result?.serverInfo?.version ?? null,
      errorMessage: null,
      installLanguage: null,
      installMessage: null,
    });
    beginIndexing(language, set);
    sessionDeferreds.get(language)?.resolve();
    sessionDeferreds.delete(language);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (rustFallbackRestarting.has(language)) return;
    initializedLanguages.delete(language);
    resetIndexingTracking();
    set({
      status: 'error',
      errorMessage: error.message,
      indexing: false,
      indexingLanguage: null,
      indexingMessage: null,
      indexingProgress: null,
    });
    sessionDeferreds.get(language)?.reject(error);
    sessionDeferreds.delete(language);
  }
}

function rejectAllSessions(error: Error): void {
  for (const deferred of sessionDeferreds.values()) deferred.reject(error);
  sessionDeferreds.clear();
  initializedLanguages.clear();
}

function rejectPendingRequests(language: string, error: Error): void {
  for (const [id, pending] of pendingRequests) {
    if (pending.language !== language) continue;
    pendingRequests.delete(id);
    pending.reject(error);
  }
}

function handleServerMessage(msg: ServerMessage, set: (partial: Partial<LspState>) => void): void {
  switch (msg.type) {
    case 'ready':
      set({ rootUri: msg.root_uri, readyLanguage: msg.language });
      void performInitialize(msg.language, msg.root_uri, set, msg.python_venv ?? null);
      break;
    case 'fetch_progress':
      set({ status: 'fetching', fetchProgress: { downloaded: msg.downloaded, total: msg.total } });
      break;
    case 'install_progress':
      set({
        status: 'installing',
        installLanguage: msg.language,
        installMessage: msg.message,
        fetchProgress: null,
      });
      break;
    case 'fetch_error': {
      const error = new Error(msg.message);
      resetIndexingTracking();
      set({ status: 'error', errorMessage: msg.message, indexing: false, indexingLanguage: null, indexingMessage: null, indexingProgress: null });
      rejectAllSessions(error);
      break;
    }
    case 'process_exited':
      if (rustFallbackRestarting.has(msg.language)) break;
      resetIndexingTracking();
      initializedLanguages.delete(msg.language);
      sessionPromises.delete(msg.language);
      sessionDeferreds.get(msg.language)?.reject(new Error(`${msg.language} language server exited`));
      sessionDeferreds.delete(msg.language);
      set({ status: 'error', errorMessage: `${msg.language} language server exited`, indexing: false, indexingLanguage: null, indexingMessage: null, indexingProgress: null });
      break;
    case 'rust_analyzer_build_scripts_crashed': {
      if (msg.language !== 'rust' || rustBuildScriptsDisabled) {
        const error = new Error('rust-analyzer build script analysis failed after restart');
        resetIndexingTracking();
        set({ status: 'error', errorMessage: error.message, indexing: false, indexingLanguage: null, indexingMessage: null, indexingProgress: null });
        rejectAllSessions(error);
        break;
      }
      rustBuildScriptsDisabled = true;
      rustFallbackRestarting.add(msg.language);
      resetIndexingTracking();
      initializedLanguages.delete(msg.language);
      rejectPendingRequests(msg.language, new Error('Restarting rust-analyzer with build scripts disabled'));
      set({ status: 'starting', errorMessage: 'rust-analyzer build script crash detected; restarting with build scripts disabled' });
      client?.send({ type: 'restart_session', language: msg.language });
      break;
    }
    case 'error': {
      const error = new Error(msg.message);
      resetIndexingTracking();
      set({ status: 'error', errorMessage: msg.message, indexing: false, indexingLanguage: null, indexingMessage: null, indexingProgress: null });
      rejectAllSessions(error);
      break;
    }
    case 'lsp': {
      const payload = msg.payload;
      if (typeof payload !== 'object' || payload === null) return;
      const record = payload as Record<string, unknown>;
      if (typeof record.id === 'number') {
        const pending = pendingRequests.get(record.id);
        if (!pending) {
          // Reply to server-initiated LSP requests such as
          // window/workDoneProgress/create. The progress capability is
          // advertised below so language servers can report their work.
          if (typeof record.method === 'string') {
            client?.send({
              type: 'lsp',
              language: msg.language,
              payload: { jsonrpc: '2.0', id: record.id, result: null },
            });
          }
          return;
        }
        pendingRequests.delete(record.id);
        if (record.error && typeof record.error === 'object') {
          const message = (record.error as Record<string, unknown>).message;
          pending.reject(new Error(typeof message === 'string' ? message : 'LSP error'));
        } else {
          // A successful post-initialize request is a stronger signal of
          // actual usability than the end of a background progress phase.
          if (pending.method !== 'initialize') markIndexingUsable(pending.language, set);
          pending.resolve(record.result);
        }
        return;
      }
      if (record.method === '$/progress') {
        handleProgress(record.params, msg.language, set);
        return;
      }
      if (record.method === 'experimental/serverStatus' && msg.language === 'rust') {
        handleRustServerStatus(record.params, set);
        return;
      }
      if (record.method === 'textDocument/publishDiagnostics') {
        applyDiagnostics(msg.language, record.params as PublishDiagnosticsParams);
        markIndexingUsable(msg.language, set);
      }
      break;
    }
    case 'file_content': {
      const pending = pendingFileReads.get(msg.id);
      if (!pending) break;
      pendingFileReads.delete(msg.id);
      if (msg.content !== null) pending.resolve(msg.content);
      else pending.reject(new Error(msg.error ?? 'Failed to read file'));
      break;
    }
  }
}

function connect(
  port: number,
  token: string,
  set: (partial: Partial<LspState>) => void,
): Promise<void> {
  const reconnecting = client !== null;
  return new Promise((resolve, reject) => {
    connectionDeferred = { resolve, reject };
    const wsClient = new LspWsClient({
      url: `ws://127.0.0.1:${port}/ws`,
      token,
      onStateChange: (wsState) => {
        if (wsState === 'connected') {
          set({ status: 'starting' });
          connectionDeferred?.resolve();
          connectionDeferred = null;
          // Reopen every language session after the reconnect loop creates a
          // fresh WebSocket/server set.
          if (reconnecting) {
            for (const language of activeLanguages) {
              initializedLanguages.delete(language);
              sessionPromises.delete(language);
              void openLanguageSession(
                language,
                effectiveWorkspaceRoot(useLspStore.getState().workspaceRootOverride),
                set,
              ).catch(() => undefined);
            }
          }
        } else if (wsState === 'error') {
          const error = new Error('Failed to connect to lsp-host');
          resetIndexingTracking();
          set({ status: 'error', errorMessage: error.message, indexing: false, indexingLanguage: null, indexingMessage: null, indexingProgress: null });
          connectionDeferred?.reject(error);
          connectionDeferred = null;
        }
      },
      onMessage: (msg) => handleServerMessage(msg, set),
    });
    client = wsClient;
    wsClient.connect();
  });
}

async function ensureConnection(set: (partial: Partial<LspState>) => void): Promise<void> {
  if (connectionPromise) return connectionPromise;
  connectionPromise = (async () => {
    set({
      status: 'connecting',
      errorMessage: null,
      fetchProgress: null,
      installLanguage: null,
      installMessage: null,
      indexing: false,
      indexingLanguage: null,
      indexingMessage: null,
      indexingProgress: null,
    });
    const launch = await launchLspHostViaNativeMessaging();
    if (launch.status !== 'started' && launch.status !== 'already_running') {
      const message =
        launch.status === 'timeout'
          ? 'No response. Close all Edge windows, restart Edge, and try again.'
          : launch.status === 'unavailable'
            ? `lsp-host is not registered. Run "node setup/setup.js" once. (${launch.message})`
            : launch.message;
      throw new Error(message);
    }
    await connect(launch.port, launch.token, set);
  })().catch((err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    set({ status: 'error', errorMessage: error.message });
    connectionPromise = null;
    throw error;
  });
  return connectionPromise;
}

/** The manual per-LSP override (StatusBar.tsx's "フォルダを選択...", still
 * useful for e.g. a monorepo subpackage that needs a different root than
 * the terminal) wins when set; otherwise falls back to the same central
 * real path terminal-host's cwd already uses (see workspaceStore.ts's
 * workspaceRealPath / .m365ce/config) — closes the gap where LSP used to
 * default to lsp-host's own launch directory (equally wrong as
 * terminal-host's old default, and for the same reason) whenever nobody
 * had ever manually corrected it. */
function effectiveWorkspaceRoot(explicitOverride: string | null): string | null {
  return explicitOverride ?? useWorkspaceStore.getState().workspaceRealPath;
}

function openLanguageSession(
  language: string,
  workspaceRoot: string | null,
  set: (partial: Partial<LspState>) => void,
): Promise<void> {
  const existing = sessionPromises.get(language);
  if (existing) return existing;

  const promise = (async () => {
    await ensureConnection(set);
    await new Promise<void>((resolve, reject) => {
      sessionDeferreds.set(language, { resolve, reject });
      client?.send({
        type: 'open_session',
        language,
        workspace_root: workspaceRoot ?? undefined,
      });
    });
  })();
  sessionPromises.set(language, promise);
  void promise.catch(() => {
    if (sessionPromises.get(language) === promise) {
      sessionPromises.delete(language);
      initializedLanguages.delete(language);
    }
  });
  return promise;
}

export const useLspStore = create<LspState>((set, get) => ({
  status: 'idle',
  fetchProgress: null,
  installLanguage: null,
  installMessage: null,
  indexing: false,
  indexingLanguage: null,
  indexingMessage: null,
  indexingProgress: null,
  errorMessage: null,
  rootUri: null,
  serverVersion: null,
  readyLanguage: null,
  workspaceRootOverride: null,

  loadWorkspaceRootOverride: async () => {
    const path = await getStoredValue<string>(WORKSPACE_ROOT_STORAGE_KEY);
    if (path) set({ workspaceRootOverride: path });
  },

  setWorkspaceRootOverride: async (path) => {
    await setStoredValue(WORKSPACE_ROOT_STORAGE_KEY, path);
    set({ workspaceRootOverride: path });
    if (!client || get().status === 'idle') return;

    for (const doc of trackedDocuments.values()) {
      monaco.editor.setModelMarkers(doc.model, `lsp-${doc.languageId}`, []);
    }
    trackedDocuments.clear();
    documentVersions.clear();
    for (const timer of changeTimers.values()) clearTimeout(timer);
    changeTimers.clear();
    initializedLanguages.clear();
    resetIndexingTracking();
    sessionPromises.clear();
    rejectAllSessions(new Error('LSP workspace changed'));
    set({
      status: 'starting',
      rootUri: null,
      readyLanguage: null,
      serverVersion: null,
      indexing: false,
      indexingLanguage: null,
      indexingMessage: null,
      indexingProgress: null,
      errorMessage: null,
    });

    // Open sessions sequentially so the host can finish tearing down the old
    // root before the next language server is started.
    let chain = Promise.resolve();
    for (const language of activeLanguages) {
      chain = chain
        .then(() => openLanguageSession(language, effectiveWorkspaceRoot(path), set))
        .catch(() => undefined);
    }
  },

  ensureSession: (language = 'rust') => {
    if (!isLspLanguage(language)) return Promise.reject(new Error(`Unsupported LSP language: ${language}`));
    activeLanguages.add(language);
    if (initializedLanguages.has(language)) return Promise.resolve();
    return openLanguageSession(language, effectiveWorkspaceRoot(get().workspaceRootOverride), set);
  },

  registerDocument: (uri, model, languageId) => {
    const key = normalizeUriKey(uri);
    trackedDocuments.set(key, { uri, model, languageId });
    documentVersions.set(key, 1);
    sendNotification(languageId, 'textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text: model.getValue() },
    });
  },

  unregisterDocument: (uri) => {
    const key = normalizeUriKey(uri);
    const timer = changeTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      changeTimers.delete(key);
    }
    const doc = trackedDocuments.get(key);
    if (!doc) return;
    trackedDocuments.delete(key);
    documentVersions.delete(key);
    sendNotification(doc.languageId, 'textDocument/didClose', { textDocument: { uri } });
  },

  notifyDidChange: (uri, languageId) => {
    const key = normalizeUriKey(uri);
    const doc = trackedDocuments.get(key);
    if (!doc) return;
    const existing = changeTimers.get(key);
    if (existing) clearTimeout(existing);
    changeTimers.set(
      key,
      setTimeout(() => {
        changeTimers.delete(key);
        const version = (documentVersions.get(key) ?? 1) + 1;
        documentVersions.set(key, version);
        sendNotification(languageId, 'textDocument/didChange', {
          textDocument: { uri: doc.uri, version },
          contentChanges: [{ text: doc.model.getValue() }],
        });
      }, CHANGE_DEBOUNCE_MS),
    );
  },

  requestDefinition: (language, uri, position) =>
    sendRequest(language, 'textDocument/definition', { textDocument: { uri }, position }),
  requestDeclaration: (language, uri, position) =>
    sendRequest(language, 'textDocument/declaration', { textDocument: { uri }, position }),
  requestImplementation: (language, uri, position) =>
    sendRequest(language, 'textDocument/implementation', { textDocument: { uri }, position }),
  requestTypeDefinition: (language, uri, position) =>
    sendRequest(language, 'textDocument/typeDefinition', { textDocument: { uri }, position }),
  requestReferences: (language, uri, position, includeDeclaration) =>
    sendRequest(language, 'textDocument/references', {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    }),
  requestDocumentSymbols: (language, uri) =>
    sendRequest(language, 'textDocument/documentSymbol', { textDocument: { uri } }),
  requestCompletion: (language, uri, position, context) =>
    sendRequest(language, 'textDocument/completion', { textDocument: { uri }, position, context }),
  requestSignatureHelp: (language, uri, position) =>
    sendRequest(language, 'textDocument/signatureHelp', { textDocument: { uri }, position }),
  requestHover: (language, uri, position) =>
    sendRequest(language, 'textDocument/hover', { textDocument: { uri }, position }),
  requestFileContent: (uri) => requestFileContentImpl(uri),
}));
