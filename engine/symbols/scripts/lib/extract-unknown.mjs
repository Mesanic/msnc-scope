import { sha256Hex } from './util.mjs';
import { emptyFacts, finalizeDefs } from './extract-util.mjs';

const BLOCK_START_RE =
  /^(?:(?:export|pub(?:lic)?|private|protected|static|async|final|abstract|function|func|fn|def|sub|proc)\s+)+([A-Za-z_$][\w$.]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?:=>)?\s*\{|^([A-Za-z_$][\w$.]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?:=>)?\s*\{/;
const KEYWORD_START_RE =
  /^(?:export\s+|pub(?:lic)?\s+|abstract\s+|final\s+|static\s+)*(class|struct|interface|trait|enum|object|record|impl|module|package)\s+([A-Za-z_][\w.]*)/;

function blockStartMatch(line) {
  const m = BLOCK_START_RE.exec(line);
  if (!m) return null;
  if (m[1] !== undefined) return { name: m[1], params: m[2] ?? '' };
  return { name: m[3], params: m[4] ?? '' };
}

function stripLineNoise(line) {
  let t = String(line);
  const cut = Math.min(
    ...[t.indexOf('//'), t.indexOf('#'), t.indexOf('--')].filter((i) => i >= 0).concat([t.length]),
  );
  t = t.slice(0, cut);
  return collapseQuotes(t);
}

function collapseQuotes(t) {
  return t.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/**
 * Structural fallback extractor for files whose extension maps to no shipped
 * grammar. Every emitted definition is honest about its provenance: kind
 * 'symbol', confidence surfaced by the resolver as 'rough', language
 * 'unknown'. Only top-level brace-delimited blocks are considered; nested
 * constructs are left to future grammars.
 */
export function extractUnknown(posixPath, text, tree, _query) {
  void tree;
  void posixPath;
  const facts = emptyFacts();
  facts.lineCount = text.split('\n').length;

  const lines = text.split('\n');
  const rawDefs = [];
  const lineStarts = new Array(lines.length);
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    lineStarts[i] = cursor;
    cursor += lines[i].length + 1;
  }
  let depth = 0;
  let pendingStart = null;
  let pendingName = null;
  let pendingSig = null;

  for (let i = 0; i < lines.length; i++) {
    const line = stripLineNoise(lines[i]);
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

    if (depth === 0) {
      const kw = KEYWORD_START_RE.exec(line.trim());
      const fnish = blockStartMatch(line.trim());
      if (kw) {
        pendingStart = i;
        pendingName = kw[2];
        pendingSig = `${kw[1]} ${kw[2]}`;
        if (opens > closes) depth += opens - closes;
        else {
          rawDefs.push(makeRoughDef(pendingName, pendingSig, pendingStart, i, lineStarts, lines));
          pendingStart = null;
        }
      } else if (fnish) {
        pendingStart = i;
        pendingName = fnish.name;
        pendingSig = `${fnish.name}(${collapseWsInline(fnish.params)})`;
        depth += opens - closes;
        if (depth <= 0) {
          rawDefs.push(makeRoughDef(pendingName, pendingSig, pendingStart, i, lineStarts, lines));
          pendingStart = null;
          depth = 0;
        }
      } else if (opens === 0 && closes === 0) {
        // plain top-level content: not a recognizable construct, skip
      } else {
        depth += opens - closes;
        if (depth < 0) depth = 0;
      }
    } else {
      depth += opens - closes;
      if (depth <= 0) {
        depth = 0;
        if (pendingStart !== null) {
          rawDefs.push(makeRoughDef(pendingName, pendingSig, pendingStart, i, lineStarts, lines));
          pendingStart = null;
        }
      }
    }
  }
  if (pendingStart !== null) {
    rawDefs.push(makeRoughDef(pendingName, pendingSig, pendingStart, lines.length - 1, lineStarts, lines));
  }

  facts.defs = finalizeDefs(rawDefs);
  return facts;
}

function collapseWsInline(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function makeRoughDef(name, sig, startLine, endLine, lineStarts, lines) {
  const cleanSig = collapseWsInline(sig ?? name ?? '');
  return {
    kind: 'symbol',
    name: name ?? '<anonymous>',
    sl: startLine + 1,
    sb: lineStarts[startLine],
    el: endLine + 1,
    eb: lineStarts[endLine] + (lines[endLine]?.length ?? 0),
    sig: cleanSig,
    sigHash: sha256Hex(cleanSig).slice(0, 16),
    exported: false,
    decorators: [],
    summary: null,
    lang: 'unknown',
    paramTokens: [],
  };
}
