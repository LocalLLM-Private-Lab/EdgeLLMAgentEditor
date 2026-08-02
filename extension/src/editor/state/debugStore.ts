import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { useTerminalStore } from './terminalStore';
import type { ServerMessage } from '../terminal/terminalProtocol';

export type DebugStatus = 'idle' | 'starting' | 'running' | 'paused' | 'stopped' | 'error';

export interface DebugAdapterResolution {
  command: string;
  args: string[];
  transport: 'stdio' | 'tcp';
  port: number | null;
  message: string;
}

export interface DebugStackFrame {
  id: number;
  name: string;
  line?: number;
  column?: number;
  source?: { name?: string; path?: string };
}

export interface DebugScope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
}

export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
}

export interface StartDebugOptions {
  adapterCommand: string;
  adapterArgs: string[];
  adapterTransport?: 'stdio' | 'tcp';
  adapterPort?: number;
  cwd?: string;
  launchArguments: Record<string, unknown>;
  sourcePath: string;
  breakpoints: number[];
}

interface DebugState {
  sessionId: string | null;
  status: DebugStatus;
  message: string | null;
  output: string;
  threadId: number | null;
  frameId: number | null;
  stackFrames: DebugStackFrame[];
  scopes: DebugScope[];
  variables: DebugVariable[];
  startOptions: StartDebugOptions | null;
  sequence: number;
  ensureAdapter: (language: string) => Promise<DebugAdapterResolution>;
  setMessage: (message: string) => void;
  start: (options: StartDebugOptions) => Promise<void>;
  stop: () => void;
  continueExecution: () => void;
  pause: () => void;
  stepOver: () => void;
  stepInto: () => void;
  stepOut: () => void;
  selectFrame: (frameId: number) => void;
  expandVariables: (variablesReference: number) => void;
  clear: () => void;
}

const EMPTY_FRAMES: DebugStackFrame[] = [];
const EMPTY_SCOPES: DebugScope[] = [];
const EMPTY_VARIABLES: DebugVariable[] = [];

let unsubscribe: (() => void) | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isNoisyCodeLldbRustFormatterLine(data: string): boolean {
  return [
    'does not have a complete definition',
    'formatters.rust',
    'formatters\\rust.py',
    'SBProcess is invalid',
    'ReadMemory error',
    'RustSynthProvider',
    'string_from_ptr',
    'get_synth_summary',
    'raise Exception',
    "Exception: ('ReadMemory error",
    'Traceback (most recent call last):',
  ].some((marker) => data.includes(marker));
}

export const useDebugStore = create<DebugState>((set, get) => {
  function sendRequest(command: string, args: Record<string, unknown> = {}) {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    const seq = get().sequence;
    set({ sequence: seq + 1 });
    useTerminalStore.getState().send({
      type: 'debug_request',
      session_id: sessionId,
      message: { seq, type: 'request', command, arguments: args },
    });
  }

  function requestStack(threadId: number) {
    set({ threadId, frameId: null, scopes: EMPTY_SCOPES, variables: EMPTY_VARIABLES });
    sendRequest('stackTrace', { threadId, startFrame: 0, levels: 50 });
  }

  function handleDapMessage(message: Record<string, unknown>) {
    const appendOutput = (text: string) => set((state) => ({ output: `${state.output}${text}` }));
    const messageType = asString(message.type);
    if (messageType === 'event') {
      const event = asString(message.event);
      const body = asRecord(message.body) ?? {};
      if (event === 'initialized') {
        const options = get().startOptions;
        if (options) {
          sendRequest('setBreakpoints', {
            source: { path: options.sourcePath },
            breakpoints: options.breakpoints.map((line) => ({ line })),
          });
          sendRequest('configurationDone');
        }
      } else if (event === 'stopped') {
        set({ status: 'paused', message: asString(body.reason) ?? '停止しました。' });
        appendOutput(`[debug] stopped: ${asString(body.reason) ?? 'breakpoint'}\n`);
        const threadId = asNumber(body.threadId);
        if (threadId !== null) requestStack(threadId);
      } else if (event === 'continued') {
        set({ status: 'running', message: null, stackFrames: [], scopes: [], variables: [] });
        appendOutput('[debug] continued\n');
      } else if (event === 'output') {
        const output = asString(body.output);
        if (output) set((state) => ({ output: `${state.output}${output}` }));
      } else if (event === 'terminated' || event === 'exited') {
        set({ status: 'stopped', message: event === 'terminated' ? 'デバッグを終了しました。' : 'プロセスが終了しました。' });
        appendOutput(`[debug] ${event}${asNumber(body.exitCode) !== null ? ` (code ${asNumber(body.exitCode)})` : ''}\n`);
      }
      return;
    }

    if (messageType !== 'response') return;
    const command = asString(message.command);
    const success = message.success !== false;
    if (!success) {
      const body = asRecord(message.body);
      const error = asRecord(body?.error);
      const detail = asString(message.message) ?? asString(error?.format) ?? 'デバッガーからエラーが返りました。';
      set((state) => ({
        status: 'error',
        message: detail,
        output: `${state.output}[DAP error] ${command ?? 'request'}: ${detail}\n`,
      }));
      return;
    }
    const body = asRecord(message.body) ?? {};
    if (command === 'initialize') {
      const options = get().startOptions;
      if (options) {
        sendRequest('launch', options.launchArguments);
        set({ status: 'running' });
        appendOutput('[debug] launch request sent\n');
      }
    } else if (command === 'launch') {
      appendOutput('[debug] launch accepted\n');
    } else if (command === 'setBreakpoints') {
      const breakpoints = Array.isArray(body.breakpoints) ? body.breakpoints : [];
      const report = breakpoints.flatMap((item) => {
        const breakpoint = asRecord(item);
        if (!breakpoint) return [];
        const line = asNumber(breakpoint.line);
        if (line === null) return [];
        const verified = breakpoint.verified === true;
        const detail = asString(breakpoint.message);
        return [`${verified ? '✓' : '×'} line ${line}${detail ? `: ${detail}` : ''}`];
      });
      if (report.length > 0) {
        appendOutput(`[debug] breakpoints\n${report.map((line) => `  ${line}`).join('\n')}\n`);
        if (report.some((line) => line.startsWith('×'))) set({ message: 'ブレークポイントを設定できない行があります。デバッグコンソールを確認してください。' });
      }
    } else if (command === 'stackTrace') {
      const frames = Array.isArray(body.stackFrames) ? body.stackFrames : [];
      const stackFrames = frames.flatMap((item) => {
        const frame = asRecord(item);
        if (!frame) return [];
        const id = asNumber(frame.id);
        const name = asString(frame.name);
        if (id === null || name === null) return [];
        const source = asRecord(frame.source);
        return [{
          id,
          name,
          line: asNumber(frame.line) ?? undefined,
          column: asNumber(frame.column) ?? undefined,
          source: source ? { name: asString(source.name) ?? undefined, path: asString(source.path) ?? undefined } : undefined,
        }];
      });
      set({ stackFrames });
      const firstFrame = stackFrames[0];
      if (firstFrame) get().selectFrame(firstFrame.id);
    } else if (command === 'scopes') {
      const scopes = (Array.isArray(body.scopes) ? body.scopes : []).flatMap((item) => {
        const scope = asRecord(item);
        if (!scope) return [];
        const name = asString(scope.name);
        const variablesReference = asNumber(scope.variablesReference);
        if (name === null || variablesReference === null) return [];
        return [{ name, variablesReference, expensive: scope.expensive === true }];
      });
      set({ scopes });
      const locals = scopes.find((scope) => /local|変数/i.test(scope.name)) ?? scopes[0];
      if (locals && locals.variablesReference > 0) sendRequest('variables', { variablesReference: locals.variablesReference });
    } else if (command === 'variables') {
      const variables = (Array.isArray(body.variables) ? body.variables : []).flatMap((item) => {
        const variable = asRecord(item);
        if (!variable) return [];
        const name = asString(variable.name);
        const value = asString(variable.value);
        if (name === null || value === null) return [];
        return [{ name, value, type: asString(variable.type) ?? undefined, variablesReference: asNumber(variable.variablesReference) ?? undefined }];
      });
      set({ variables });
    }
  }

  function handleServerMessage(message: ServerMessage) {
    const sessionId = get().sessionId;
    if (!sessionId || !('session_id' in message) || message.session_id !== sessionId) return;
    if (message.type === 'debug_started') {
      set((state) => ({
        status: 'starting',
        message: 'デバッグアダプターに接続しました。',
        output: `${state.output}[debug] adapter started (pid ${message.pid})\n`,
      }));
      sendRequest('initialize', {
        clientID: 'edge-llm-agent-editor',
        clientName: 'Edge LLM Agent Editor',
        adapterID: 'generic',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsVariableType: true,
      });
    } else if (message.type === 'debug_message') {
      handleDapMessage(message.message);
    } else if (message.type === 'debug_output') {
      const warning = '[CodeLLDB] Rust内部変数の一部を表示できないため、フォーマッターの診断をスキップしました。\n';
      set((state) => {
        if (isNoisyCodeLldbRustFormatterLine(message.data)) {
          return state.output.includes(warning) ? state : { output: `${state.output}${warning}` };
        }
        return { output: `${state.output}${message.data}\n` };
      });
    } else if (message.type === 'debug_error') {
      set((state) => ({
        status: 'error',
        message: message.message,
        output: `${state.output}[adapter error] ${message.message}\n`,
      }));
    } else if (message.type === 'debug_exited') {
      const status = get().status;
      set((state) => ({
        status: status === 'error' ? 'error' : 'stopped',
        message: status === 'error' ? state.message : `デバッグセッションが終了しました (終了コード: ${message.exit_code ?? '不明'})。`,
        output: `${state.output}[debug] adapter exited (code ${message.exit_code ?? 'unknown'})\n`,
      }));
      unsubscribe?.();
      unsubscribe = null;
    }
  }

  return {
    sessionId: null,
    status: 'idle',
    message: null,
    output: '',
    threadId: null,
    frameId: null,
    stackFrames: EMPTY_FRAMES,
    scopes: EMPTY_SCOPES,
    variables: EMPTY_VARIABLES,
    startOptions: null,
    sequence: 1,
    ensureAdapter: async (language) => {
      await useTerminalStore.getState().ensureConnected();
      if (!(await useTerminalStore.getState().waitForConnection())) throw new Error('ターミナルホストに接続できません。');
      const requestId = uuid();
      return new Promise<DebugAdapterResolution>((resolve, reject) => {
        let finished = false;
        let timeoutId: number | undefined;
        const unsubscribeAdapter = useTerminalStore.getState().subscribe((message) => {
          if (
            message.type !== 'debug_adapter_installing' &&
            message.type !== 'debug_adapter_ready' &&
            message.type !== 'debug_adapter_error'
          ) return;
          if (message.request_id !== requestId) return;
          if (message.type === 'debug_adapter_ready') {
            finish(() => resolve({ command: message.adapter_command, args: message.adapter_args, transport: message.adapter_transport, port: message.adapter_port, message: message.message }));
          } else if (message.type === 'debug_adapter_error') {
            finish(() => reject(new Error(message.message)));
          } else {
            set({ status: 'starting', message: message.message });
          }
        });
        const finish = (callback: () => void) => {
          if (finished) return;
          finished = true;
          unsubscribeAdapter();
          if (timeoutId !== undefined) window.clearTimeout(timeoutId);
          callback();
        };
        timeoutId = window.setTimeout(() => finish(() => reject(new Error('DAPアダプターの確認がタイムアウトしました。'))), 120000);
        useTerminalStore.getState().send({ type: 'debug_ensure_adapter', request_id: requestId, language });
      });
    },
    setMessage: (message) => set({ status: 'starting', message }),
    start: async (options) => {
      get().stop();
      await useTerminalStore.getState().ensureConnected();
      if (!(await useTerminalStore.getState().waitForConnection())) {
        set({ status: 'error', message: 'ターミナルホストに接続できません。' });
        return;
      }
      const sessionId = uuid();
      unsubscribe = useTerminalStore.getState().subscribe(handleServerMessage);
      set({ sessionId, status: 'starting', message: 'デバッグアダプターを起動しています...', output: '', threadId: null, frameId: null, stackFrames: [], scopes: [], variables: [], startOptions: options, sequence: 1 });
      useTerminalStore.getState().send({
        type: 'debug_start',
        session_id: sessionId,
        adapter_command: options.adapterCommand,
        adapter_args: options.adapterArgs,
        adapter_transport: options.adapterTransport ?? 'stdio',
        adapter_port: options.adapterPort,
        cwd: options.cwd,
      });
    },
    stop: () => {
      const sessionId = get().sessionId;
      if (sessionId) useTerminalStore.getState().send({ type: 'debug_stop', session_id: sessionId });
      unsubscribe?.();
      unsubscribe = null;
      set({ sessionId: null, status: 'stopped', message: 'デバッグを停止しました。' });
    },
    continueExecution: () => {
      sendRequest('continue', { threadId: get().threadId ?? 1 });
      set({ status: 'running', message: null });
    },
    pause: () => sendRequest('pause', { threadId: get().threadId ?? 1 }),
    stepOver: () => sendRequest('next', { threadId: get().threadId ?? 1 }),
    stepInto: () => sendRequest('stepIn', { threadId: get().threadId ?? 1 }),
    stepOut: () => sendRequest('stepOut', { threadId: get().threadId ?? 1 }),
    selectFrame: (frameId) => {
      set({ frameId, scopes: [], variables: [] });
      sendRequest('scopes', { frameId });
    },
    expandVariables: (variablesReference) => sendRequest('variables', { variablesReference }),
    clear: () => set({ sessionId: null, status: 'idle', message: null, output: '', threadId: null, frameId: null, stackFrames: [], scopes: [], variables: [], startOptions: null }),
  };
});
