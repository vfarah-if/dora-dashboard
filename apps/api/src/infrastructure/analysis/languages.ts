const LANGUAGES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  go: "Go",
  rs: "Rust",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  swift: "Swift",
  scala: "Scala",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++",
  hh: "C++",
  m: "Objective-C",
  mm: "Objective-C",
  lua: "Lua",
  pl: "Perl",
  sol: "Solidity",
  vue: "Vue",
  erl: "Erlang",
  zig: "Zig",
  dart: "Dart",
};

const extensionOf = (file: string): string => {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
};

export const languageOf = (file: string): string => {
  const ext = extensionOf(file);
  return LANGUAGES[ext] ?? (ext ? ext.toUpperCase() : "Other");
};

/** JavaScript and TypeScript, which are measured from a syntax tree rather than by lizard (ADR 0025). */
export const SCRIPT_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"] as const;

const SCRIPTS = new Set<string>(SCRIPT_EXTENSIONS);

export const isScriptPath = (file: string): boolean => SCRIPTS.has(extensionOf(file));
