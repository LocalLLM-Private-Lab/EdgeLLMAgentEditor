import * as monaco from 'monaco-editor';
import { create } from 'zustand';
import { LspWsClient } from './lspWsClient';
import type { ServerMessage } from './lspProtocol';
import { launchLspHostViaNativeMessaging } from './lspNativeLaunch';
import { type LspRange, lspRangeToMonaco, normalizeUriKey } from './uriTranslation';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';

export type LspStatus = 'idle' | 'connecting' | 'fetching' | 'starting' | 'ready' | 'error';

const WORKSPACE_ROOT_STORAGE_KEY = 'lspWorkspaceRootOverride';

interface LspState {
  status: LspStatus;
  fetchProgress: { downloaded: number; total: number | null } | null;
  errorMessage: string | null;
  rootUri: string | null;
  serverVersion: string | null;
  /** Absolute filesystem path the user has explicitly told lsp-host to use
   * as the Cargo project root, overriding its own launch-directory guess —
   * see docs/lsp_protocol.md's `workspace_root` field. Null means "let
   * lsp-host use its own launch directory" (frequently wrong when
   * auto-launched via Native Messaging, since that cwd is lsp-host.exe's
   * own folder, not the user's project — there's no browser API that can
   * supply the real one). */
  workspaceRootOverride: string | null;
  loadWorkspaceRootOverride: () => Promise<void>;
  /** Persists the override and, if a session is already connected,
   * restarts it against the new root on the same WebSocket connection
   * (lsp-host tears down the old rust-analyzer process and spawns a fresh
   * one — see ws_server.rs's OpenSession handler) and re-registers every
   * currently open .rs tab against the new root. */
  setWorkspaceRootOverride: (path: string | null) => Promise<void>;
  /** Idempotent: launches lsp-host (if needed), connects, opens the rust
   * session and completes the LSP `initialize` handshake. Safe to call
   * repeatedly — concurrent/later calls await the same in-flight attempt,
   * and a prior failure lets the next call retry from scratch. */
  ensureSession: () => Promise<void>;
  registerDocument: (uri: string, model: monaco.editor.ITextModel, languageId: string) => void;
  unregisterDocument: (uri: string) => void;
  notifyDidChange: (uri: string) => void;
  requestDefinition: (uri: string, position: { line: number; character: number }) => Promise<unknown>;
  requestHover: (uri: string, position: { line: number; character: number }) => Promise<unknown>;
}

// Pure bookkeeping that never needs to trigger a React re-render on its own
// — kept as module-level state rather than inside the zustand store, same
// as textmateTokenization.ts's `loadedLangIds` singleton-guard pattern.
let client: LspWsClient | null = null;
let sessionPromise: Promise<void> | null = null;
let readyDeferred: { resolve: () => void; reject: (err: Error) => void } | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

// Keyed by normalizeUriKey(uri) (case-insensitive), not the raw uri string —
// rust-analyzer may echo back a differently-cased `file://` URI than the one
// this client sent (e.g. Windows drive-letter case), so a raw-string map
// would silently miss lookups from server-originated URIs (diagnostics,
// definition results). `uri` inside TrackedDocument keeps the *original*,
// correctly-cased string this client constructed via pathSegmentsToUri —
// that's what gets sent back to the server on every outgoing request, since
// mangling case there could break the server's own file resolution.
interface TrackedDocument {
  uri: string;
  model: monaco.editor.ITextModel;
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

/** Reverse lookup for lspProviders.ts: given a Monaco model, find the LSP
 * `file://` URI it was registered under (registerDocument populates
 * trackedDocuments; there's no back-reference on the model itself). Returns
 * the original correctly-cased uri (not the normalized map key) — this is
 * what definition/hover requests send back to the server. Linear scan over
 * open rust documents only — small N in practice. */
export function getUriForModel(model: monaco.editor.ITextModel): string | null {
  for (const doc of trackedDocuments.values()) {
    if (doc.model === model) return doc.uri;
  }
  return null;
}

function sendRequest(method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!client) {
      reject(new Error('LSPセッションが接続されていません'));
      return;
    }
    const id = nextRequestId++;
    pendingRequests.set(id, { resolve, reject });
    client.send({ type: 'lsp', payload: { jsonrpc: '2.0', id, method, params } });
  });
}

function sendNotification(method: string, params: unknown): void {
  client?.send({ type: 'lsp', payload: { jsonrpc: '2.0', method, params } });
}

interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Array<{ range: LspRange; severity?: number; message: string }>;
}

function applyDiagnostics(params: PublishDiagnosticsParams): void {
  const doc = trackedDocuments.get(normalizeUriKey(params.uri));
  if (!doc) return;
  const markers: monaco.editor.IMarkerData[] = params.diagnostics.map((d) => ({
    ...lspRangeToMonaco(d.range),
    message: d.message,
    severity: SEVERITY_MAP[d.severity ?? 1] ?? monaco.MarkerSeverity.Error,
  }));
  monaco.editor.setModelMarkers(doc.model, 'rust-analyzer', markers);
}

async function performInitialize(rootUri: string, set: (partial: Partial<LspState>) => void): Promise<void> {
  try {
    const result = (await sendRequest('initialize', {
      processId: null,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          definition: { linkSupport: false },
          hover: { contentFormat: ['plaintext', 'markdown'] },
          publishDiagnostics: { relatedInformation: false },
        },
      },
    })) as { serverInfo?: { version?: string } } | undefined;
    sendNotification('initialized', {});
    set({ status: 'ready', serverVersion: result?.serverInfo?.version ?? null, errorMessage: null });
    readyDeferred?.resolve();
    readyDeferred = null;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    set({ status: 'error', errorMessage: error.message });
    readyDeferred?.reject(error);
    readyDeferred = null;
  }
}

function handleServerMessage(msg: ServerMessage, set: (partial: Partial<LspState>) => void): void {
  switch (msg.type) {
    case 'ready':
      set({ rootUri: msg.root_uri });
      void performInitialize(msg.root_uri, set);
      break;
    case 'fetch_progress':
      set({ status: 'fetching', fetchProgress: { downloaded: msg.downloaded, total: msg.total } });
      break;
    case 'fetch_error':
      set({ status: 'error', errorMessage: msg.message });
      readyDeferred?.reject(new Error(msg.message));
      readyDeferred = null;
      break;
    case 'process_exited':
      set({ status: 'error', errorMessage: 'rust-analyzerプロセスが終了しました' });
      break;
    case 'error':
      set({ status: 'error', errorMessage: msg.message });
      readyDeferred?.reject(new Error(msg.message));
      readyDeferred = null;
      break;
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
        applyDiagnostics(record.params as PublishDiagnosticsParams);
      }
      break;
    }
  }
}

function connectAndOpenSession(
  port: number,
  token: string,
  workspaceRoot: string | null,
  set: (partial: Partial<LspState>) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    readyDeferred = { resolve, reject };
    const wsClient = new LspWsClient({
      url: `ws://127.0.0.1:${port}/ws`,
      token,
      onStateChange: (wsState) => {
        if (wsState === 'connected') {
          set({ status: 'starting' });
          wsClient.send({ type: 'open_session', language: 'rust', workspace_root: workspaceRoot ?? undefined });
        } else if (wsState === 'error') {
          const error = new Error('lsp-hostへの接続に失敗しました');
          set({ status: 'error', errorMessage: error.message });
          readyDeferred?.reject(error);
          readyDeferred = null;
        }
        // A 'disconnected' event while a session was already ready means
        // lspWsClient's own reconnect loop is retrying — status is left as
        // reported until the reconnect either succeeds or errors out.
      },
      onMessage: (msg) => handleServerMessage(msg, set),
    });
    client = wsClient;
    wsClient.connect();
  });
}

export const useLspStore = create<LspState>((set, get) => ({
  status: 'idle',
  fetchProgress: null,
  errorMessage: null,
  rootUri: null,
  serverVersion: null,
  workspaceRootOverride: null,

  loadWorkspaceRootOverride: async () => {
    const path = await getStoredValue<string>(WORKSPACE_ROOT_STORAGE_KEY);
    if (path) set({ workspaceRootOverride: path });
  },

  setWorkspaceRootOverride: async (path) => {
    await setStoredValue(WORKSPACE_ROOT_STORAGE_KEY, path);
    set({ workspaceRootOverride: path });

    if (!client || get().status === 'idle') return;

    // A session is already up against the (wrong) old root — restart it in
    // place rather than tearing down the WebSocket connection: reopening a
    // whole new connection would leave the old rust-analyzer process
    // orphaned server-side (lsp-host scopes one rust-analyzer per
    // connection, not globally), and lsp-host's OpenSession handler already
    // knows how to swap roots on an existing connection (see ws_server.rs).
    for (const doc of trackedDocuments.values()) {
      monaco.editor.setModelMarkers(doc.model, 'rust-analyzer', []);
    }
    trackedDocuments.clear();
    documentVersions.clear();
    for (const timer of changeTimers.values()) clearTimeout(timer);
    changeTimers.clear();
    set({ status: 'starting', rootUri: null, serverVersion: null, errorMessage: null, fetchProgress: null });
    client.send({ type: 'open_session', language: 'rust', workspace_root: path ?? undefined });
  },

  ensureSession: () => {
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      try {
        set({ status: 'connecting', errorMessage: null, fetchProgress: null });
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
        await connectAndOpenSession(launch.port, launch.token, get().workspaceRootOverride, set);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ status: 'error', errorMessage: message });
        sessionPromise = null;
        throw err;
      }
    })();
    return sessionPromise;
  },

  registerDocument: (uri, model, languageId) => {
    const key = normalizeUriKey(uri);
    trackedDocuments.set(key, { uri, model });
    documentVersions.set(key, 1);
    sendNotification('textDocument/didOpen', {
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
    if (!trackedDocuments.has(key)) return;
    trackedDocuments.delete(key);
    documentVersions.delete(key);
    sendNotification('textDocument/didClose', { textDocument: { uri } });
  },

  notifyDidChange: (uri) => {
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
        sendNotification('textDocument/didChange', {
          textDocument: { uri: doc.uri, version },
          contentChanges: [{ text: doc.model.getValue() }],
        });
      }, CHANGE_DEBOUNCE_MS),
    );
  },

  requestDefinition: (uri, position) => sendRequest('textDocument/definition', { textDocument: { uri }, position }),
  requestHover: (uri, position) => sendRequest('textDocument/hover', { textDocument: { uri }, position }),
}));
