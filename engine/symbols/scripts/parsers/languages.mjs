import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PARSERS_DIR = path.dirname(fileURLToPath(import.meta.url));

export const SCRIPTS_DIR = path.resolve(PARSERS_DIR, '..');
export const VENDOR_DIR = path.join(SCRIPTS_DIR, 'vendor');
export const RUNTIME_DIR = path.join(VENDOR_DIR, 'web-tree-sitter');

export const LANGUAGES = {
  python: {
    id: 'python',
    label: 'Python',
    wasm: ['grammars/tree-sitter-python.wasm'],
    grammar: 'grammars/tree-sitter-python.wasm',
    extensions: ['.py', '.pyi'],
    queryFile: 'queries/python.scm',
  },
  tsx: {
    id: 'tsx',
    label: 'TSX/JSX',
    wasm: ['grammars/tree-sitter-tsx.wasm'],
    grammar: 'grammars/tree-sitter-tsx.wasm',
    extensions: ['.jsx', '.tsx'],
    queryFile: 'queries/typescript.scm',
  },
  typescript: {
    id: 'typescript',
    label: 'TypeScript',
    wasm: ['grammars/tree-sitter-typescript.wasm'],
    grammar: 'grammars/tree-sitter-typescript.wasm',
    extensions: ['.cjs', '.cts', '.js', '.mjs', '.mts', '.ts'],
    queryFile: 'queries/typescript.scm',
  },
  go: {
    id: 'go',
    label: 'Go',
    wasm: ['grammars/tree-sitter-go.wasm'],
    grammar: 'grammars/tree-sitter-go.wasm',
    extensions: ['.go'],
    queryFile: 'queries/go.scm',
  },
  rust: {
    id: 'rust',
    label: 'Rust',
    wasm: ['grammars/tree-sitter-rust.wasm'],
    grammar: 'grammars/tree-sitter-rust.wasm',
    extensions: ['.rs'],
    queryFile: 'queries/rust.scm',
  },
  java: {
    id: 'java',
    label: 'Java',
    wasm: ['grammars/tree-sitter-java.wasm'],
    grammar: 'grammars/tree-sitter-java.wasm',
    extensions: ['.java'],
    queryFile: 'queries/java.scm',
  },
  'c-sharp': {
    id: 'c-sharp',
    label: 'C#',
    wasm: ['grammars/tree-sitter-c_sharp.wasm'],
    grammar: 'grammars/tree-sitter-c_sharp.wasm',
    extensions: ['.cs'],
    queryFile: 'queries/c-sharp.scm',
  },
};

export function languageForFile(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  const ext = path.posix.extname(normalized).toLowerCase();
  if (!ext) return null;
  for (const id of Object.keys(LANGUAGES).sort()) {
    if (LANGUAGES[id].extensions.includes(ext)) return LANGUAGES[id];
  }
  return null;
}
