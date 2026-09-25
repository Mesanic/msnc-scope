import { collapseWs, firstParagraph } from './util.mjs';

const IDENT_RE = /[A-Za-z_$][\w$]*/g;

export function spanOf(node) {
  return {
    sl: node.startPosition.row + 1,
    sb: node.startIndex,
    el: node.endPosition.row + 1,
    eb: node.endIndex,
  };
}

export function unquote(fragmentText) {
  return String(fragmentText ?? '');
}

export function capText(caps, name) {
  return caps.get(name)?.node?.text;
}

export function capMap(captures) {
  const map = new Map();
  for (const c of captures) {
    if (!map.has(c.name)) map.set(c.name, c);
  }
  return map;
}

export function identTokens(text) {
  return String(text).match(IDENT_RE) ?? [];
}

export function stripJsdoc(commentText) {
  let t = String(commentText).trim();
  if (!t.startsWith('/**')) return null;
  t = t.replace(/^\/\*\*/, '').replace(/\*\/$/, '');
  const lines = t.split('\n').map((l) => l.replace(/^\s*\*+/, '').trim());
  return firstParagraph(lines.join('\n'));
}

export function ancestorsInclude(node, type) {
  let n = node.parent;
  while (n) {
    if (n.type === type) return true;
    n = n.parent;
  }
  return false;
}

export function findAncestor(node, type) {
  let n = node.parent;
  while (n) {
    if (n.type === type) return n;
    n = n.parent;
  }
  return null;
}

export function precedingDecoratorsAndComment(anchor) {
  const decorators = [];
  const comments = [];
  let n = anchor.previousNamedSibling;
  while (n && (n.type === 'decorator' || n.type === 'comment')) {
    if (n.type === 'decorator') decorators.unshift(collapseWs(n.text));
    else comments.unshift(n.text);
    n = n.previousNamedSibling;
  }
  return { decorators, comments };
}

export function collectInnerDecorators(defNode, anchor) {
  const out = [];
  const sources = anchor !== defNode ? [defNode, anchor] : [defNode];
  for (const srcNode of sources) {
    for (let i = 0; i < srcNode.childCount; i++) {
      const c = srcNode.child(i);
      if (!c || !c.isNamed) continue;
      if (c.type === 'decorator') {
        const text = collapseWs(c.text);
        if (out[out.length - 1] !== text) out.push(text);
      }
    }
  }
  return out;
}

export function stringContentOf(exprStmt) {
  const inner = exprStmt && exprStmt.childCount > 0 ? exprStmt.child(0) : null;
  if (!inner || !inner.isNamed || inner.type !== 'string') return null;
  for (let j = 0; j < inner.childCount; j++) {
    const part = inner.child(j);
    if (part && part.type === 'string_content') return firstParagraph(part.text);
  }
  return firstParagraph(inner.text.replace(/^['"]{1,3}|['"]{1,3}$/g, ''));
}

export function docstringFromBody(bodyNode) {
  if (!bodyNode || !bodyNode.childCount) return null;
  for (let i = 0; i < bodyNode.childCount; i++) {
    const child = bodyNode.child(i);
    if (!child || !child.isNamed) continue;
    if (child.type === 'expression_statement' && child.childCount > 0) {
      const summary = stringContentOf(child);
      if (summary) return summary;
    }
    break;
  }
  return null;
}

export function flattenMemberChain(node, memberType, partType) {
  const segments = [];
  let cur = node;
  while (cur && cur.type === memberType) {
    const propField = partType === 'property_identifier' ? 'property' : 'attribute';
    const prop = cur.childForFieldName(propField);
    if (!prop) return null;
    segments.unshift(prop.text);
    const obj = cur.childForFieldName('object');
    if (!obj) return null;
    cur = obj;
  }
  if (!cur) return null;
  if (cur.type === 'identifier') segments.unshift(cur.text);
  else if (cur.type === 'this') segments.unshift('this');
  else return null;
  return segments;
}

export function enclosingDefIndex(defs, position, excludeKey) {
  let best = -1;
  let bestSize = Infinity;
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    if (excludeKey && d.key === excludeKey) continue;
    if (d.sb <= position && position < d.eb) {
      const size = d.eb - d.sb;
      if (size < bestSize) {
        bestSize = size;
        best = i;
      }
    }
  }
  return best;
}

export function finalizeDefs(rawDefs) {
  rawDefs.sort((a, b) => (a.sb - b.sb) || (a.eb - b.eb) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rawDefs.map((d, i) => {
    const key = `d${i + 1}`;
    return { ...d, key };
  });
}

export function emptyFacts() {
  return {
    defs: [],
    imports: [],
    reexports: [],
    calls: [],
    heritage: [],
    routes: [],
    locals: [],
    lineCount: 1,
    moduleSummary: null,
  };
}
