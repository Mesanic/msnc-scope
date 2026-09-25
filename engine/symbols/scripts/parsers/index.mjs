import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LANGUAGES, RUNTIME_DIR, VENDOR_DIR } from './languages.mjs';

const PARSERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ENTRY = path.join(RUNTIME_DIR, 'web-tree-sitter.mjs');
const RUNTIME_WASM = path.join(RUNTIME_DIR, 'web-tree-sitter.wasm');

let runtimePromise = null;
const languagePromises = new Map();
const parserCache = new Map();

function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = import(pathToFileURL(RUNTIME_ENTRY).href)
      .then(async (mod) => {
        const ParserCtor = mod.Parser ?? mod.default?.Parser;
        const LanguageCtor = mod.Language ?? mod.default?.Language ?? ParserCtor?.Language;
        const QueryCtor = mod.Query ?? mod.default?.Query;
        if (!ParserCtor || !LanguageCtor || !QueryCtor) {
          throw new Error(`missing Parser/Language/Query exports in ${RUNTIME_ENTRY}`);
        }
        await ParserCtor.init({ locateFile: () => RUNTIME_WASM });
        return { Parser: ParserCtor, Language: LanguageCtor, Query: QueryCtor };
      })
      .catch((err) => {
        runtimePromise = null;
        throw new Error(
          `symbols: failed to initialize vendored web-tree-sitter (${RUNTIME_ENTRY}): ${err?.message ?? err}`,
          { cause: err },
        );
      });
  }
  return runtimePromise;
}

function requireSpec(lang) {
  const spec = LANGUAGES[lang];
  if (!spec) {
    const shipped = Object.keys(LANGUAGES).sort().join(', ');
    throw new Error(`symbols: unshipped language "${lang}". shipped languages: ${shipped}.`);
  }
  return spec;
}

export { LANGUAGES, VENDOR_DIR };

export function loadLanguage(lang) {
  const spec = requireSpec(lang);
  const cached = languagePromises.get(lang);
  if (cached) return cached;

  const promise = (async () => {
    const { Language } = await loadRuntime();
    const wasmAbs = path.join(VENDOR_DIR, spec.grammar);
    let bytes;
    try {
      bytes = await readFile(wasmAbs);
    } catch (err) {
      throw new Error(
        `symbols: missing vendored grammar wasm for "${lang}" (${spec.grammar}); see vendor/MANIFEST.json (${err?.code} ${err?.path ?? ''})`,
        { cause: err },
      );
    }
    try {
      return await Language.load(bytes);
    } catch (err) {
      throw new Error(
        `symbols: failed to load grammar wasm for "${lang}" (${wasmAbs}): ${err?.message ?? err}`,
        { cause: err },
      );
    }
  })().catch((err) => {
    languagePromises.delete(lang);
    throw err;
  });
  languagePromises.set(lang, promise);
  return promise;
}

export async function getParser(lang) {
  const spec = requireSpec(lang);
  const cachedHandle = parserCache.get(lang);
  if (cachedHandle) return cachedHandle;

  const [language, { Parser, Query }] = await Promise.all([loadLanguage(lang), loadRuntime()]);
  const parser = new Parser();
  parser.setLanguage(language);

  let queryPromise = null;

  const handle = {
    lang,
    label: spec.label,
    language,
    parser,
    parse(source) {
      return parser.parse(source);
    },
    loadQuery() {
      if (!queryPromise) {
        queryPromise = (async () => {
          const text = await readFile(path.join(PARSERS_DIR, spec.queryFile), 'utf8');
          return new Query(language, text);
        })().catch((err) => {
          queryPromise = null;
          throw new Error(
            `symbols: failed to compile query file "${spec.queryFile}" for "${lang}": ${err?.message ?? err}`,
            { cause: err },
          );
        });
      }
      return queryPromise;
    },
  };
  parserCache.set(lang, handle);
  return handle;
}
