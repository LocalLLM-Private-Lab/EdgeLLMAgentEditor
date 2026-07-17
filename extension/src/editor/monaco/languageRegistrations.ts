const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  rs: 'rust',
  py: 'python',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'shell',
  ps1: 'powershell',
  xml: 'xml',
  go: 'go',
  rb: 'ruby',
  c: 'c',
  // .h is ambiguous between C and C++; default to c (same limitation VS
  // Code itself has without a project-level language override).
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  sv: 'system-verilog',
  svh: 'system-verilog',
  v: 'verilog',
};

export function languageFromFilename(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return 'plaintext';
  const ext = name.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? 'plaintext';
}
