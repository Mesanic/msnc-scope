// Per-language extraction: imports, exported symbols with line anchors, doc lines.
// Philosophy: recall over precision. Regex cannot parse these languages exactly, so the file graph
// prefers a slightly incomplete graph that is honest over a complete one that invents edges.
// Agent write-back and `expand` fill the gaps.
import { joinPosix, truncate } from './store.mjs';

export const EXT_LANG = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'ts', '.jsx': 'ts', '.mjs': 'ts', '.cjs': 'ts',
  '.py': 'py', '.pyi': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'java',
  '.cs': 'cs',
  '.md': 'md', '.markdown': 'md',
  '.json': 'data', '.yml': 'data', '.yaml': 'data', '.toml': 'data',
  '.html': 'markup', '.css': 'markup', '.scss': 'markup',
};

const COMMENT_STYLE = { ts: 'c', go: 'c', rs: 'c', java: 'c', cs: 'c', py: 'py' };

const STOP_DOC = /^(?:eslint|ts-|prettier|@ts-|jshint|global |istanbul|c8 |#!|copyright|licen[sc]e|spdx|coding[:=]|-\*-)/i;

// Blank out comments while preserving byte offsets, so line numbers stay valid.
// String literals are preserved because import specifiers live inside them.
export function blankComments(text, style) {
  if (!style) return text;
  const out = text.split('');
  const n = text.length;
  let i = 0;
  let state = 'code';
  let closer = '';
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (state === 'code') {
      if (style === 'c' && c === '/' && d === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'line'; continue; }
      if (style === 'c' && c === '/' && d === '*') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'block'; continue; }
      if (style === 'py' && c === '#') { out[i] = ' '; i += 1; state = 'line'; continue; }
      if (style === 'py' && (c === '"' || c === "'") && text[i + 1] === c && text[i + 2] === c) {
        closer = c + c + c; i += 3; state = 'triple'; continue;
      }
      if (c === '"' || c === "'" || (style !== 'py' && c === '`')) { closer = c; i += 1; state = 'string'; continue; }
      i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; i += 1; } else { out[i] = ' '; i += 1; }
      continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'code'; continue; }
      if (c !== '\n') out[i] = ' ';
      i += 1; continue;
    }
    if (state === 'triple') {
      if (c !== '\n') out[i] = ' ';
      if (text.startsWith(closer, i)) { out[i + 1] = ' '; out[i + 2] = ' '; i += 3; state = 'code'; continue; }
      i += 1; continue;
    }
    // string
    if (c === '\\') { i += 2; continue; }
    if (c === closer) { state = 'code'; i += 1; continue; }
    if (c === '\n' && closer !== '`') { state = 'code'; i += 1; continue; }
    i += 1;
  }
  return out.join('');
}

function lineIndex(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') offsets.push(i + 1);
  return offsets;
}

function lineAt(offsets, pos) {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

function collect(re, code, offsets, fn) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(code)) !== null) {
    const r = fn(m);
    if (r !== undefined && r !== null) {
      const line = lineAt(offsets, m.index + (m[0].length - m[0].trimStart().length));
      if (Array.isArray(r)) for (const v of r) out.push({ value: v, line });
      else out.push({ value: r, line });
    }
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

// --- per-language rules ----------------------------------------------------

const TS_IMPORT = /(?:^|\n)[ \t]*import[ \t]+(?:type[ \t]+)?(?:[\w$*{}\s,]+?[ \t]+from[ \t]+)?['"]([^'"]+)['"]/g;
const TS_EXPORT_FROM = /(?:^|\n)[ \t]*export[ \t]+(?:\*(?:[ \t]+as[ \t]+[\w$]+)?|\{[^}]*\})[ \t]*from[ \t]*['"]([^'"]+)['"]/g;
const TS_REQUIRE = /require\([ \t]*['"]([^'"]+)['"][ \t]*\)/g;
const TS_DYNAMIC = /\bimport\([ \t]*['"]([^'"]+)['"][ \t]*\)/g;
const TS_DECL = /^[ \t]*export[ \t]+(?:default[ \t]+)?(?:async[ \t]+)?(?:abstract[ \t]+)?(?:function\*?|class|const|let|var|interface|type|enum)[ \t]+([A-Za-z_$][\w$]*)/gm;
const TS_EXPORT_LIST = /^[ \t]*export[ \t]*\{([^}]*)\}[ \t]*(?!from)/gm;
// Only a bare identifier: `export default async function X` is TS_DECL's, not "async".
const TS_DEFAULT = /^[ \t]*export[ \t]+default[ \t]+(?!(?:async|function|class|abstract|new|await)\b)([A-Za-z_$][\w$]*)/gm;
const TS_CJS = /^[ \t]*module\.exports(?:\.([A-Za-z_$][\w$]*))?[ \t]*=/gm;
const TS_LOCAL_FN = /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?function\*?[ \t]+([A-Za-z_$][\w$]*)|^[ \t]*(?:export[ \t]+)?class[ \t]+([A-Za-z_$][\w$]*)|^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)[ \t]*=>/gm;

const PY_IMPORT = /^[ \t]*import[ \t]+([\w., \t]+)$/gm;
const PY_FROM = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+/gm;
const PY_DEF = /^(?:async[ \t]+)?def[ \t]+(\w+)/gm;
const PY_CLASS = /^class[ \t]+(\w+)/gm;
const PY_DEF_ANY = /^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)|^[ \t]*class[ \t]+(\w+)/gm;

const GO_PACKAGE = /^package[ \t]+(\w+)/m;
const GO_IMPORT_ONE = /^[ \t]*import[ \t]+(?:\w+[ \t]+)?"([^"]+)"/gm;
const GO_FUNC = /^func[ \t]+(?:\([^)]*\)[ \t]*)?([A-Za-z_]\w*)/gm;
const GO_TYPE = /^type[ \t]+([A-Za-z_]\w*)/gm;

const RS_USE = /^[ \t]*(?:pub[ \t]+)?use[ \t]+([\w:]+)/gm;
const RS_MOD = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm;
const RS_FN = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:async[ \t]+)?fn[ \t]+(\w+)/gm;
const RS_TYPE = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:struct|enum|trait)[ \t]+(\w+)/gm;

const JAVA_PACKAGE = /^package[ \t]+([\w.]+)[ \t]*;/m;
const JAVA_IMPORT = /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+?)(?:\.\*)?[ \t]*;/gm;
const JAVA_TYPE = /^[ \t]*(?:public[ \t]+|protected[ \t]+|private[ \t]+)?(?:static[ \t]+)?(?:final[ \t]+)?(?:abstract[ \t]+)?(?:class|interface|enum|record)[ \t]+(\w+)/gm;
const JAVA_METHOD = /^[ \t]+(?:public|protected|private)[ \t]+(?:static[ \t]+)?(?:final[ \t]+)?[\w<>[\],. \t]+?[ \t]+(\w+)[ \t]*\(/gm;

const CS_USING = /^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?([\w.]+)[ \t]*;/gm;
const CS_NAMESPACE = /^[ \t]*namespace[ \t]+([\w.]+)/m;
const CS_TYPE = /^[ \t]*(?:public[ \t]+|internal[ \t]+|private[ \t]+|protected[ \t]+)?(?:static[ \t]+|sealed[ \t]+|abstract[ \t]+|partial[ \t]+)*(?:class|interface|struct|enum|record)[ \t]+(\w+)/gm;

const MD_HEADING = /^(#{1,3})[ \t]+(.+?)[ \t]*$/gm;
const PATH_TOKEN = /(?:^|[\s`("'[])((?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6})/g;
const ADR_TOKEN = /\b(ADR[- ]?\d{1,4})\b/g;
const NUMBERED_DOC_TOKEN = /(?:^|[\s`("'[])((?:[\w.-]+\/)+\d{2,4})(?![\w./-])/g;

// --- doc line --------------------------------------------------------------

// The first paragraph of the header, not the first line: headers wrap at 80 columns, and the
// summary budget (not the wrap width) should decide where the description stops.
function docLine(text, lang) {
  const lines = text.split('\n', 40);
  const para = [];
  const done = () => para.join(' ').length > 400;
  if (lang === 'md') {
    let front = lines[0] && lines[0].trim() === '---'; // YAML frontmatter: skip to the closing ---
    for (const raw of lines.slice(front ? 1 : 0)) {
      const t = raw.trim();
      if (front) { if (t === '---') front = false; continue; }
      if (!t || t.startsWith('#') || t.startsWith('---') || t.startsWith('<!--')) { if (para.length) break; continue; }
      para.push(t.replace(/^[*->\s]+/, ''));
      if (done()) break;
    }
    return para.join(' ');
  }
  if (lang === 'py') {
    let quote = null;
    for (const raw of lines) {
      const t = raw.trim();
      if (quote) {
        const end = t.indexOf(quote);
        const c = (end >= 0 ? t.slice(0, end) : t).trim();
        if (c) para.push(c);
        if (!c || end >= 0 || done()) break;
        continue;
      }
      if (!t) { if (para.length) break; continue; }
      const m = t.match(/^("""|''')(.*)$/);
      if (m) {
        quote = m[1];
        const end = m[2].indexOf(quote);
        const c = (end >= 0 ? m[2].slice(0, end) : m[2]).trim();
        if (c) para.push(c);
        if (end >= 0) break;
        continue;
      }
      if (t.startsWith('#')) {
        const c = t.replace(/^#+\s*/, '');
        if (c && (para.length || !STOP_DOC.test(c))) para.push(c);
        else if (para.length) break;
        if (done()) break;
        continue;
      }
      break;
    }
    return para.join(' ');
  }
  let inBlock = false;
  for (const raw of lines) {
    let t = raw.trim();
    if (t.startsWith('#!')) continue;
    const closes = t.endsWith('*/');
    if (closes) t = t.slice(0, -2).trim();
    const m = t.match(/^(?:\/\/+|\/\*+|\*+)\s*(.*)$/);
    if (!m && !inBlock) { if (t || para.length) break; continue; }
    if (t.startsWith('/*')) inBlock = true;
    const c = (m ? m[1] : t).trim();
    if (!c) { if (para.length) break; }
    else if (para.length || !(STOP_DOC.test(c) || /^[-=*_]{3,}$/.test(c) || c.split(/\s+/).length < 2)) para.push(c);
    if (closes) { inBlock = false; if (para.length) break; }
    if (done()) break;
  }
  return para.join(' ');
}

// --- main analyzer ---------------------------------------------------------

export function analyze(rel, text, lang) {
  const code = blankComments(text, COMMENT_STYLE[lang]);
  const offsets = lineIndex(text);
  const imports = [];
  const symbols = [];
  const locals = [];
  const meta = {};
  const push = (arr, items) => { for (const it of items) arr.push(it); };

  if (lang === 'ts') {
    push(imports, collect(TS_IMPORT, code, offsets, (m) => m[1]));
    push(imports, collect(TS_EXPORT_FROM, code, offsets, (m) => m[1]));
    push(imports, collect(TS_REQUIRE, code, offsets, (m) => m[1]));
    push(imports, collect(TS_DYNAMIC, code, offsets, (m) => m[1]));
    push(symbols, collect(TS_DECL, code, offsets, (m) => m[1]));
    push(symbols, collect(TS_DEFAULT, code, offsets, (m) => m[1]));
    push(symbols, collect(TS_CJS, code, offsets, (m) => m[1] || 'module.exports'));
    push(symbols, collect(TS_EXPORT_LIST, code, offsets, (m) => m[1]
      .split(',')
      .map((p) => p.trim().split(/\s+as\s+/).pop().trim())
      .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p))));
    push(locals, collect(TS_LOCAL_FN, code, offsets, (m) => m[1] || m[2] || m[3]));
  } else if (lang === 'py') {
    push(imports, collect(PY_IMPORT, code, offsets, (m) => m[1]
      .split(',').map((p) => p.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)));
    push(imports, collect(PY_FROM, code, offsets, (m) => m[1]));
    push(symbols, collect(PY_DEF, code, offsets, (m) => (m[1].startsWith('_') ? null : m[1])));
    push(symbols, collect(PY_CLASS, code, offsets, (m) => m[1]));
    push(locals, collect(PY_DEF_ANY, code, offsets, (m) => m[1] || m[2]));
  } else if (lang === 'go') {
    const pkg = code.match(GO_PACKAGE);
    if (pkg) meta.pkg = pkg[1];
    push(imports, collect(GO_IMPORT_ONE, code, offsets, (m) => m[1]));
    push(imports, goBlockImports(code, offsets));
    push(symbols, collect(GO_FUNC, code, offsets, (m) => m[1]));
    push(symbols, collect(GO_TYPE, code, offsets, (m) => m[1]));
    push(locals, symbols.slice());
  } else if (lang === 'rs') {
    push(imports, collect(RS_USE, code, offsets, (m) => m[1]));
    push(imports, collect(RS_MOD, code, offsets, (m) => 'mod:' + m[1]));
    push(symbols, collect(RS_FN, code, offsets, (m) => m[1]));
    push(symbols, collect(RS_TYPE, code, offsets, (m) => m[1]));
    push(locals, symbols.slice());
  } else if (lang === 'java') {
    const pkg = code.match(JAVA_PACKAGE);
    if (pkg) meta.pkg = pkg[1];
    push(imports, collect(JAVA_IMPORT, code, offsets, (m) => m[1]));
    push(symbols, collect(JAVA_TYPE, code, offsets, (m) => m[1]));
    push(locals, collect(JAVA_METHOD, code, offsets, (m) => m[1]));
  } else if (lang === 'cs') {
    const ns = code.match(CS_NAMESPACE);
    if (ns) meta.pkg = ns[1];
    push(imports, collect(CS_USING, code, offsets, (m) => m[1]));
    push(symbols, collect(CS_TYPE, code, offsets, (m) => m[1]));
    push(locals, symbols.slice());
  } else if (lang === 'md') {
    push(symbols, collect(MD_HEADING, code, offsets, (m) => m[2].replace(/[`*_]/g, '')));
  }

  const seenSym = new Set();
  const anchors = [];
  for (const s of symbols) {
    if (!s.value || seenSym.has(s.value)) continue;
    seenSym.add(s.value);
    anchors.push([String(s.value), s.line]);
  }

  const seenImp = new Set();
  const specs = [];
  for (const im of imports) {
    if (!im.value || seenImp.has(im.value)) continue;
    seenImp.add(im.value);
    specs.push(String(im.value));
  }

  return {
    lang,
    specs,
    anchors,
    locals: locals.filter((l) => l.value).map((l) => [String(l.value), l.line]),
    doc: docLine(text, lang),
    loc: offsets.length,
    meta,
    // Docs mention paths anywhere; code cites docs only in comments (string literals hold routes, not references).
    mentions: pathMentions(lang === 'md' ? text : commentsOnly(text, code)),
  };
}

function goBlockImports(code, offsets) {
  const out = [];
  const lines = code.split('\n');
  let inBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!inBlock && /^import\s*\($/.test(t)) { inBlock = true; continue; }
    if (inBlock) {
      if (t === ')') { inBlock = false; continue; }
      const m = t.match(/^(?:[\w.]+\s+)?"([^"]+)"/);
      if (m) out.push({ value: m[1], line: i + 1 });
    }
  }
  return out;
}

// Three shapes of reference: a full path (`src/auth/login.ts`), an ADR by number (`ADR-0003`), or a
// numbered-doc prefix (`spec/07`, `rfcs/0042`). The last two are resolved by scan against the
// files it knows, so a citation in a header comment becomes a `documents` edge from the doc.
export function pathMentions(text) {
  const out = new Set();
  for (const re of [PATH_TOKEN, ADR_TOKEN, NUMBERED_DOC_TOKEN]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) out.add(m[1].replace(/^\.\//, ''));
  }
  return [...out];
}

// The inverse of blankComments: keep only what it blanked (comments, docstrings), as spaces elsewhere.
function commentsOnly(text, code) {
  if (text === code) return '';
  let out = '';
  for (let i = 0; i < text.length; i += 1) out += code[i] === text[i] ? ' ' : text[i];
  return out;
}

// --- import resolution -----------------------------------------------------

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export function resolveSpec(spec, fromRel, ctx) {
  const lang = ctx.langOf(fromRel);
  const dir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '.';
  const has = (p) => (ctx.known.has(p) ? p : null);

  if (lang === 'ts') {
    const probe = (base) => {
      // NodeNext ESM writes the emitted extension: "./money.js" means money.ts.
      const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
      return has(base)
        || TS_EXTS.map((e) => has(base + e)).find(Boolean)
        || (stripped !== base && TS_EXTS.map((e) => has(stripped + e)).find(Boolean))
        || TS_EXTS.map((e) => has(base + '/index' + e)).find(Boolean)
        || null;
    };
    if (spec.startsWith('.')) return probe(joinPosix(dir, spec));
    return resolveBareTs(spec, fromRel, ctx, probe);
  }

  if (lang === 'py') {
    let mod = spec;
    let baseDir = '';
    const dots = mod.match(/^\.+/);
    if (dots) {
      mod = mod.slice(dots[0].length);
      let d = dir.split('/').filter(Boolean);
      for (let i = 1; i < dots[0].length; i += 1) d = d.slice(0, -1);
      baseDir = d.join('/');
    }
    const rel = mod.split('.').filter(Boolean).join('/');
    const bases = dots ? [baseDir] : ['', dir, 'src'];
    for (const b of bases) {
      const p = b ? joinPosix(b, rel) : rel;
      const hit = has(p + '.py') || has(p + '/__init__.py') || has(p + '.pyi');
      if (hit) return hit;
    }
    return null;
  }

  if (lang === 'go') {
    if (ctx.goModule && spec.startsWith(ctx.goModule)) {
      const sub = spec.slice(ctx.goModule.length).replace(/^\//, '');
      return ctx.dirWithFiles.has(sub) ? { mod: sub } : null;
    }
    return null;
  }

  if (lang === 'rs') {
    if (spec.startsWith('mod:')) {
      const name = spec.slice(4);
      return has(joinPosix(dir, name + '.rs')) || has(joinPosix(dir, name + '/mod.rs')) || null;
    }
    const parts = spec.split('::').filter((p) => p && p !== 'crate' && p !== 'self' && p !== 'super');
    if (!parts.length) return null;
    for (let i = parts.length; i > 0; i -= 1) {
      const rel = parts.slice(0, i).join('/');
      const hit = has('src/' + rel + '.rs') || has('src/' + rel + '/mod.rs') || has(rel + '.rs');
      if (hit) return hit;
    }
    return null;
  }

  if (lang === 'java' || lang === 'cs') {
    const parts = spec.split('.').filter(Boolean);
    if (!parts.length) return null;
    const tail = parts.slice(-2).join('/');
    const hits = ctx.byPathSuffix(tail, lang === 'java' ? '.java' : '.cs');
    if (hits.length === 1) return hits[0];
    const last = parts[parts.length - 1];
    const named = ctx.byBasename(last + (lang === 'java' ? '.java' : '.cs'));
    return named.length === 1 ? named[0] : null;
  }

  return null;
}

// Bare specifiers: tsconfig `paths` aliases (nearest config above the importer wins), then
// workspace packages by name (`@scope/pkg[/subpath]` via package.json `exports`, else `src/`).
// Anything else is a third-party dependency and stays unresolved on purpose.
function resolveBareTs(spec, fromRel, ctx, probe) {
  for (const cfg of ctx.tsPaths || []) {
    if (cfg.dir && !fromRel.startsWith(cfg.dir + '/')) continue;
    for (const r of cfg.rules) {
      if (!spec.startsWith(r.pre) || !spec.endsWith(r.suf) || spec.length < r.pre.length + r.suf.length) continue;
      const star = spec.slice(r.pre.length, spec.length - r.suf.length);
      for (const t of r.targets) {
        const hit = probe(joinPosix(cfg.base, t.replace('*', star)));
        if (hit) return hit;
      }
    }
  }
  const m = spec.match(/^(@[^/]+\/[^/]+|[^@./][^/]*)(?:\/(.+))?$/);
  const pkg = m && ctx.packages ? ctx.packages.get(m[1]) : null;
  if (!pkg) return null;
  const target = pkg.map[m[2] ? './' + m[2] : '.'];
  if (target) {
    // Published entries often point at build output that the file graph ignores; fall back to source.
    return probe(joinPosix(pkg.dir, target))
      || probe(joinPosix(pkg.dir, target.replace(/^(?:\.\/)?(?:dist|build|lib|out)\//, 'src/')))
      || null;
  }
  // ponytail: no `exports` pattern matching ("./*": "./src/*.ts"); src/<subpath> covers the common case
  return m[2] ? (probe(joinPosix(pkg.dir, 'src/' + m[2])) || probe(joinPosix(pkg.dir, m[2]))) : null;
}

// --- summaries -------------------------------------------------------------

// The doc line is the summary; structure fills what it leaves. A header comment that explains the
// file beats five export names, and the names are still in anchors and the index — so they go
// last and are the first thing dropped when the budget is tight.
export function structuralSummary(rel, analysis, counts, maxChars) {
  const { lang, anchors, loc, doc } = analysis;
  const bits = [];
  if (lang === 'md') {
    if (anchors.length) bits.push(`sections: ${anchors.slice(0, 4).map((a) => a[0]).join(', ')}`);
    bits.push(`${loc} lines`);
  } else if (lang === 'data' || lang === 'markup') {
    bits.push(`${lang === 'data' ? 'config/data' : 'markup'}, ${loc} lines`);
  } else {
    bits.push(`${loc} loc`);
    if (counts.in) bits.push(`used by ${counts.in}`);
    if (counts.out) bits.push(`imports ${counts.out}`);
    if (anchors.length) bits.push(`exports ${anchors.slice(0, 5).map((a) => a[0]).join(', ')}`);
  }
  let out = doc ? truncate(doc, maxChars - 12) : ''; // always leaves room for " — NNNN loc"
  let sep = out ? ' — ' : '';
  for (const b of bits) {
    if (out.length + sep.length + b.length > maxChars) continue;
    out += sep + b;
    sep = ' · ';
  }
  return out;
}
