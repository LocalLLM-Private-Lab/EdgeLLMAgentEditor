import * as monaco from 'monaco-editor';
import { create } from 'zustand';
import { LspWsClient } from './lspWsClient';
import type { ServerMessage } from './lspProtocol';
import { launchLspHostViaNativeMessaging } from './lspNativeLaunch';
import { isLspLanguage } from './lspLanguages';
import { type LspRange, lspRangeToMonaco, normalizeUriKey } from './uriTranslation';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';

export type LspStatus = 'idle' | 'connecting' | 'fetching' | 'installing' | 'starting' | 'ready' | 'error';

const WORKSPACE_ROOT_STORAGE_KEY = 'lspWorkspaceRootOverride';

interface LspState {
  status: LspStatus;
  fetchProgress: { downloaded: number; total: number | null } | null;
  installLanguage: string | null;
  installMessage: string | null;
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
  { language: string; resolve: (value: unknown) => void; reject: (err: Error) => void }
>();
let rustBuildScriptsDisabled = false;
const rustFallbackRestarting = new Set<string>();

interface TrackedDocument {
  uri: string;
  model: monaco.editor.ITextModel;
  languageId: string;
}
const trackedDocuments = new Map<string, TrackedDocument>();
const documentVersions = new Map<string, number>();
const changeTimers = new Map<string, ReturnType<typeof setTimeout>>();

const CHANGE_DEBOUNCE_MS = 300;

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
      reject(new Error('LSPセッションが接続されていません'));
      return;
    }
    const id = nextRequestId++;
    pendingRequests.set(id, { language, resolve, reject });
    client.send({ type: 'lsp', language, payload: { jsonrpc: '2.0', id, method, params } });
  });
}

function sendNotification(language: string, method: string, params: unknown): void {
  client?.send({ type: 'lsp', language, payload: { jsonrpc: '2.0', method, params } });
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
    sessionDeferreds.get(language)?.resolve();
    sessionDeferreds.delete(language);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (rustFallbackRestarting.has(language)) return;
    initializedLanguages.delete(language);
    set({ status: 'error', errorMessage: error.message });
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
      set({ status: 'error', errorMessage: msg.message });
      rejectAllSessions(error);
      break;
    }
    case 'process_exited':
      if (rustFallbackRestarting.has(msg.language)) break;
      initializedLanguages.delete(msg.language);
      sessionPromises.delete(msg.language);
      sessionDeferreds.get(msg.language)?.reject(new Error(`${msg.language} の言語サーバーが終了しました`));
      sessionDeferreds.delete(msg.language);
      set({ status: 'error', errorMessage: `${msg.language} の言語サーバーが終了しました` });
      break;
    case 'rust_analyzer_build_scripts_crashed': {
      if (msg.language !== 'rust' || rustBuildScriptsDisabled) {
        const error = new Error('rust-analyzerのbuild script解析が再起動後も失敗しました');
        set({ status: 'error', errorMessage: error.message });
        rejectAllSessions(error);
        break;
      }
      rustBuildScriptsDisabled = true;
      rustFallbackRestarting.add(msg.language);
      initializedLanguages.delete(msg.language);
      rejectPendingRequests(msg.language, new Error('rust-analyzerをbuild script無効で再起動しています'));
      set({ status: 'starting', errorMessage: 'rust-analyzerのbuild scriptクラッシュを検知。無効化して再起動中です' });
      client?.send({ type: 'restart_session', language: msg.language });
      break;
    }
    case 'error': {
      const error = new Error(msg.message);
      set({ status: 'error', errorMessage: msg.message });
      rejectAllSessions(error);
      break;
    }
    case 'lsp': {
      const payload = msg.payload;
      if (typeof payload !== 'object' || payload === null) return;
      const record = payload as Record<string, unknown>;
      if (typeof record.id === 'number') {
        const pending = pendingRequests.get(record.id);
        if (!pending) return;
        pendingRequests.delete(record.id);
        if (record.error && typeof record.error === 'object') {
          const message = (record.error as Record<string, unknown>).message;
          pending.reject(new Error(typeof message === 'string' ? message : 'LSPエラー'));
        } else {
          pending.resolve(record.result);
        }
        return;
      }
      if (record.method === 'textDocument/publishDiagnostics') {
        applyDiagnostics(msg.language, record.params as PublishDiagnosticsParams);
      }
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
              void openLanguageSession(language, useLspStore.getState().workspaceRootOverride, set).catch(
                () => undefined,
              );
            }
          }
        } else if (wsState === 'error') {
          const error = new Error('lsp-hostへの接続に失敗しました');
          set({ status: 'error', errorMessage: error.message });
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
    });
    const launch = await launchLspHostViaNativeMessaging();
    if (launch.status !== 'started' && launch.status !== 'already_running') {
      const message =
        launch.status === 'timeout'
          ? '応答がありません。Edgeを完全に再起動(全ウィンドウを閉じる)してから再度お試しください。'
          : launch.status === 'unavailable'
            ? `lsp-hostが未登録です。lsp-host/install-native-messaging-host.bat を一度実行してください。(${launch.message})`
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
    sessionPromises.clear();
    rejectAllSessions(new Error('LSPワークスペースを変更しました'));
    set({ status: 'starting', rootUri: null, readyLanguage: null, serverVersion: null, errorMessage: null });

    // Open sessions sequentially so the host can finish tearing down the old
    // root before the next language server is started.
    let chain = Promise.resolve();
    for (const language of activeLanguages) {
      chain = chain.then(() => openLanguageSession(language, path, set)).catch(() => undefined);
    }
  },

  ensureSession: (language = 'rust') => {
    if (!isLspLanguage(language)) return Promise.reject(new Error(`未対応のLSP言語: ${language}`));
    activeLanguages.add(language);
    if (initializedLanguages.has(language)) return Promise.resolve();
    return openLanguageSession(language, get().workspaceRootOverride, set);
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
}));
