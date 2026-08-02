import { create } from 'zustand';

interface BreakpointState {
  breakpoints: Record<string, number[]>;
  toggleBreakpoint: (path: string, line: number) => void;
  clearBreakpoints: (path: string) => void;
}

export const useBreakpointStore = create<BreakpointState>((set) => ({
  breakpoints: {},
  toggleBreakpoint: (path, line) =>
    set((state) => {
      const current = state.breakpoints[path] ?? [];
      const next = current.includes(line) ? current.filter((item) => item !== line) : [...current, line].sort((a, b) => a - b);
      const breakpoints = { ...state.breakpoints };
      if (next.length === 0) delete breakpoints[path];
      else breakpoints[path] = next;
      return { breakpoints };
    }),
  clearBreakpoints: (path) =>
    set((state) => {
      const breakpoints = { ...state.breakpoints };
      delete breakpoints[path];
      return { breakpoints };
    }),
}));
