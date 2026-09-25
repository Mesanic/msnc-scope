import { extractCSharp } from './extract-csharp.mjs';
import { extractGo } from './extract-go.mjs';
import { extractJava } from './extract-java.mjs';
import { extractPython } from './extract-python.mjs';
import { extractRust } from './extract-rust.mjs';
import { extractTypescript } from './extract-typescript.mjs';

export { emptyFacts } from './extract-util.mjs';
export { extractTypescript };
export { extractPython };
export { extractGo };
export { extractRust };
export { extractJava };
export { extractCSharp };

const EXTRACTORS = {
  go: extractGo,
  rust: extractRust,
  java: extractJava,
  'c-sharp': extractCSharp,
};

export function extractForLang(lang, posixPath, text, tree, query) {
  if (lang === 'python') return extractPython(posixPath, text, tree, query);
  const extractor = EXTRACTORS[lang];
  if (extractor) return extractor(posixPath, text, tree, query);
  return extractTypescript(posixPath, text, tree, query);
}
