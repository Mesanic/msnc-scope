import { collapseWs, firstParagraph, sha256Hex } from './util.mjs';
import {
  capMap,
  capText,
  emptyFacts,
  enclosingDefIndex,
  finalizeDefs,
  identTokens,
  spanOf,
} from './extract-util.mjs';

const SPRING_ROUTE_RE = /^(Get|Post|Put|Patch|Delete)Mapping$/;
const SPRING_ANY_RE = /^RequestMapping$/;

function precedingJavaDoc(node) {
  const comments = [];
  let n = node.previousNamedSibling;
  while (n && (n.type === 'line_comment' || n.type === 'block_comment')) {
    comments.unshift(n.text);
    n = n.previousNamedSibling;
  }
  const doc = [...comments].reverse().find((c) => c.trimStart().startsWith('/**'));
  if (!doc) return null;
  let t = doc.replace(/^\s*\/\*\*/, '').replace(/\*\/\s*$/, '');
  return firstParagraph(
    t
      .split('\n')
      .map((l) => l.replace(/^\s*\*+\s?/, '').trimEnd())
      .join('\n'),
  );
}

function annotationsOf(defNode) {
  const out = [];
  for (let i = 0; i < defNode.childCount; i++) {
    const c = defNode.child(i);
    if (!c || !c.isNamed || c.type !== 'modifiers') continue;
    for (let j = 0; j < c.childCount; j++) {
      const m = c.child(j);
      if (!m || !m.isNamed) continue;
      if (m.type === 'marker_annotation' || m.type === 'annotation') {
        out.push(collapseWs(m.text));
      }
    }
  }
  return out;
}

function typeIdentifiersIn(node) {
  const out = [];
  if (!node) return out;
  const walk = (n) => {
    if (!n || !n.isNamed) return;
    if (n.type === 'type_identifier') {
      out.push(n.text);
      return;
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  };
  walk(node);
  return out;
}

function verbFromAnnotationName(name, argsText) {
  const m = SPRING_ROUTE_RE.exec(name);
  if (m) return m[1].toUpperCase();
  if (SPRING_ANY_RE.test(name)) {
    const mm = /method\s*=\s*RequestMethod\.(\w+)/i.exec(argsText ?? '');
    if (mm) return mm[1].toUpperCase();
    return 'ANY';
  }
  return null;
}

function springPathFromArgs(argsText) {
  // annotation_argument_list node text keeps its surrounding parens; drop them.
  let t = String(argsText ?? '').trim();
  if (t.startsWith('(') && t.endsWith(')')) t = t.slice(1, -1);
  t = t.trim();
  if (!t) return '';
  // Brace/array form ({"/a", "/b"}): only a SINGLE string literal yields a
  // unique path. Returns null when the annotation names several paths —
  // collapsing them to the first (or to an empty path) would fabricate a
  // route node that matches no real endpoint.
  if (t.startsWith('{')) {
    const literals = [...t.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    return literals.length === 1 ? literals[0] : null;
  }
  const positional = /^"([^"]*)"/.exec(t);
  if (positional) return positional[1];
  const named = /(?:^|,)\s*(?:value|path)\s*=\s*"([^"]*)"/.exec(t);
  if (named) return named[1];
  return '';
}

export function extractJava(posixPath, text, tree, query) {
  const facts = emptyFacts();
  facts.lineCount = text.split('\n').length;
  const rawDefs = [];
  const seenDefNodes = new Set();

  for (const match of query.matches(tree.rootNode)) {
    const caps = capMap(match.captures);

    if (caps.has('pk.name')) {
      facts.packageName = capText(caps, 'pk.name');
      continue;
    }

    if (caps.has('im.stmt')) {
      const stmt = caps.get('im.stmt').node;
      let spec = null;
      let wildcard = false;
      let isStatic = false;
      for (let i = 0; i < stmt.childCount; i++) {
        const c = stmt.child(i);
        if (!c) continue;
        if (!c.isNamed) {
          if (c.text === 'static') isStatic = true;
          continue;
        }
        if (c.type === 'scoped_identifier' || c.type === 'identifier') spec = c.text;
        else if (c.type === 'asterisk') wildcard = true;
      }
      if (spec) facts.imports.push({ spec, names: [], ns: null, defaultAlias: null, level: 0, static: isStatic, wildcard });
      continue;
    }

    if (caps.has('ra.def')) {
      const defNode = caps.get('ra.def').node;
      const name = capText(caps, 'ra.name');
      const argsText = caps.get('ra.args')?.node?.text ?? '';
      const verb = verbFromAnnotationName(name, argsText);
      const pathText = springPathFromArgs(argsText);
      if (verb && pathText !== null) {
        const span = spanOf(defNode);
        facts.routes.push({
          verb,
          path: pathText,
          sl: span.sl,
          sb: span.sb,
          el: span.el,
          eb: span.eb,
          confidence: 'exact',
        });
      }
      continue;
    }

    if (caps.has('ra0.def')) {
      const defNode = caps.get('ra0.def').node;
      const name = capText(caps, 'ra0.name');
      const verb = verbFromAnnotationName(name, '');
      if (verb && verb !== 'ANY') {
        const span = spanOf(defNode);
        facts.routes.push({
          verb,
          path: '',
          sl: span.sl,
          sb: span.sb,
          el: span.el,
          eb: span.eb,
          confidence: 'exact',
        });
      }
      continue;
    }

    if (caps.has('cra.def')) {
      const argsText = caps.get('cra.args')?.node?.text ?? '';
      // An ambiguous class-level prefix ({"/a","/b"}) degrades to no prefix —
      // child routes keep their own unique paths rather than being dropped.
      const prefix = springPathFromArgs(argsText);
      facts.routePrefix = prefix === null ? '' : prefix;
      continue;
    }

    if (caps.has('loc.name')) {
      facts.locals.push({ name: capText(caps, 'loc.name'), sb: caps.get('loc.name').node.startIndex });
      continue;
    }

    if (caps.has('cl.id') || caps.has('cl.obj')) {
      let segments;
      let sb;
      if (caps.has('cl.obj')) {
        const objNode = caps.get('cl.obj').node;
        const prop = capText(caps, 'cl.prop');
        segments = [...objNode.text.split('.'), prop];
        sb = objNode.startIndex;
      } else {
        const idNode = caps.get('cl.id').node;
        segments = [idNode.text];
        sb = idNode.startIndex;
      }
      facts.calls.push({
        calleeText: segments.join('.'),
        head: segments[0],
        prop: segments.length > 1 ? segments[segments.length - 1] : null,
        selfRef: false,
        isNew: false,
        sb,
      });
      continue;
    }

    const fam =
      caps.has('cls.def') ? { key: 'cls', kind: 'class', nameCap: 'cls.name' }
      : caps.has('iface.def') ? { key: 'iface', kind: 'interface', nameCap: 'iface.name' }
      : caps.has('enum.def') ? { key: 'enum', kind: 'enum', nameCap: 'enum.name' }
      : caps.has('rec.def') ? { key: 'rec', kind: 'class', nameCap: 'rec.name' }
      : caps.has('m.def') ? { key: 'm', kind: 'method', nameCap: 'm.name', paramsCap: 'm.params' }
      : caps.has('ctor.def') ? { key: 'ctor', kind: 'method', nameCap: 'ctor.name', paramsCap: 'ctor.params' }
      : null;
    if (!fam) continue;

    const defNode = caps.get(`${fam.key}.def`).node;
    if (seenDefNodes.has(defNode.id)) continue;
    seenDefNodes.add(defNode.id);
    const name = capText(caps, fam.nameCap);
    const paramsCap = fam.paramsCap ? caps.get(fam.paramsCap) : null;
    const paramsInner = paramsCap ? collapseWs(paramsCap.node.text.replace(/^\(/, '').replace(/\)$/, '')) : '';
    const sig = `${name}(${paramsInner})`;

    const heritage = [];
    if (fam.key === 'cls') {
      const superNode = caps.get('cls.super')?.node ?? null;
      const supers = typeIdentifiersIn(superNode);
      if (supers.length > 0) heritage.push({ rel: 'extends', name: supers[0] });
      const ifaceListNode = caps.get('cls.ifaces')?.node ?? null;
      for (const t of typeIdentifiersIn(ifaceListNode)) heritage.push({ rel: 'implements', name: t });
    } else if (fam.key === 'iface') {
      const extNode = caps.get('iface.ext')?.node ?? null;
      for (const t of typeIdentifiersIn(extNode)) heritage.push({ rel: 'extends', name: t });
    } else if (fam.key === 'enum' || fam.key === 'rec') {
      const ifaceListNode = caps.get(`${fam.key}.ifaces`)?.node ?? null;
      for (const t of typeIdentifiersIn(ifaceListNode)) heritage.push({ rel: 'implements', name: t });
    }

    rawDefs.push({
      kind: fam.kind,
      name,
      ...spanOf(defNode),
      sig,
      sigHash: sha256Hex(sig).slice(0, 16),
      exported: !/\bprivate\b/.test((defNode.childForFieldName('modifiers') ?? { text: '' }).text),
      decorators: annotationsOf(defNode),
      summary: precedingJavaDoc(defNode),
      lang: 'java',
      paramTokens: paramsCap ? [...new Set(identTokens(paramsCap.node.text))] : [],
      _heritage: heritage,
    });
  }

  const defs = finalizeDefs(rawDefs);
  facts.defs = defs;

  for (const def of defs) {
    const idx = enclosingDefIndex(defs, def.sb, def.key);
    if (idx >= 0) def.ownerKey = defs[idx].key;
    if (def._heritage) {
      for (const h of def._heritage) facts.heritage.push({ defKey: def.key, rel: h.rel, name: h.name });
      delete def._heritage;
    }
  }

  for (const call of facts.calls) {
    const idx = enclosingDefIndex(defs, call.sb);
    call.defKey = idx >= 0 ? defs[idx].key : null;
  }

  const prefix = facts.routePrefix ?? '';
  for (const route of facts.routes) {
    const idx = enclosingDefIndex(defs, route.sb);
    route.defKey = idx >= 0 ? defs[idx].key : null;
    if (prefix && route.path && !route.path.startsWith('/')) route.path = `${prefix}/${route.path}`;
    else if (prefix && !route.path) route.path = prefix;
    else if (prefix && route.path.startsWith('/')) route.path = `${prefix}${route.path}`;
  }

  return facts;
}
