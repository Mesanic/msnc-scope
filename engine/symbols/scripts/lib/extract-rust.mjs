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

function precedingRustDocAndAttrs(node) {
  const attributes = [];
  const comments = [];
  let n = node.previousNamedSibling;
  while (n && (n.type === 'attribute_item' || n.type === 'line_comment' || n.type === 'block_comment')) {
    if (n.type === 'attribute_item') attributes.unshift(collapseWs(n.text));
    else comments.unshift(n.text);
    n = n.previousNamedSibling;
  }
  return { attributes, comments };
}

function docSummaryFromComments(comments) {
  const docLines = comments
    .filter((c) => c.trimStart().startsWith('///'))
    .map((c) => collapseWs(c.replace(/^\s*\/\/\/\s?/, '')));
  if (docLines.length === 0) return null;
  return firstParagraph(docLines.join(' '));
}

function flattenUseArgument(node, prefix, out, flags) {
  if (!node || !node.isNamed) return;
  switch (node.type) {
    case 'identifier':
      out.push({ path: prefix ? `${prefix}::${node.text}` : node.text, alias: null });
      return;
    case 'self':
      out.push({ path: prefix ? `${prefix}::self` : 'self', alias: null });
      return;
    case 'crate':
      out.push({ path: prefix ? `${prefix}::crate` : 'crate', alias: null });
      return;
    case 'super':
      out.push({ path: prefix ? `${prefix}::super` : 'super', alias: null });
      return;
    case 'scoped_identifier': {
      const nameNode = node.childForFieldName('name');
      const pathNode = node.childForFieldName('path');
      const innerPrefix = pathNode ? scopedPathText(pathNode) : '';
      const name = nameNode?.text ?? '';
      const joined = [prefix, innerPrefix, name].filter((s) => s.length > 0).join('::');
      out.push({ path: joined, alias: null });
      return;
    }
    case 'use_wildcard': {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (!c || !c.isNamed) continue;
        const before = out.length;
        flattenUseArgument(c, prefix, out, flags);
        for (let j = before; j < out.length; j++) out[j].wildcard = true;
        if (out.length === before && !c.isNamed) flags.wildcard = true;
      }
      if (node.childCount === 0) flags.wildcard = true;
      return;
    }
    case 'use_as_clause': {
      const pathNode = node.childForFieldName('path');
      const aliasNode = node.childForFieldName('alias');
      const before = out.length;
      flattenUseArgument(pathNode, prefix, out, flags);
      if (out.length > before) {
        const entry = out[out.length - 1];
        entry.alias = aliasNode ? aliasNode.text : null;
      }
      return;
    }
    case 'use_list':
    case 'use_wildcard_list': {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (!c || !c.isNamed || c.type === 'use_wildcard_list') continue;
        flattenUseArgument(c, prefix, out, flags);
      }
      return;
    }
    case 'scoped_use_list': {
      const pathNode = node.childForFieldName('path');
      const listNode = node.childForFieldName('list');
      const base = pathNode ? scopedPathText(pathNode) : prefix;
      if (listNode) flattenUseArgument(listNode, base, out, flags);
      return;
    }
    default:
      return;
  }
}

function scopedPathText(node) {
  if (!node) return '';
  if (node.type === 'identifier' || node.type === 'crate' || node.type === 'self' || node.type === 'super') {
    return node.text;
  }
  if (node.type === 'scoped_identifier') {
    const nameNode = node.childForFieldName('name');
    const pathNode = node.childForFieldName('path');
    const base = scopedPathText(pathNode);
    const name = nameNode?.text ?? '';
    return base ? `${base}::${name}` : name;
  }
  return node.text;
}

function splitPath(text) {
  return String(text).split('::').filter((s) => s.length > 0);
}

export function extractRust(posixPath, text, tree, query) {
  const facts = emptyFacts();
  facts.lineCount = text.split('\n').length;
  const rawDefs = [];
  const seenImplNodes = new Set();

  for (const match of query.matches(tree.rootNode)) {
    const caps = capMap(match.captures);

    if (caps.has('im.stmt')) {
      const stmt = caps.get('im.stmt').node;
      const arg = stmt.childForFieldName('argument');
      const entries = [];
      const flags = { wildcard: false };
      flattenUseArgument(arg, '', entries, flags);
      for (const e of entries) {
        const segs = splitPath(e.path);
        const wildcard = Boolean(e.wildcard);
        facts.imports.push({
          spec: wildcard ? `${e.path}::*` : e.path,
          names: [],
          ns: e.alias ?? null,
          wildcard,
          segments: segs,
          level: 0,
        });
      }
      continue;
    }

    if (caps.has('rb.method')) {
      const methodNode = caps.get('rb.method').node;
      const callNode = methodNode.parent?.parent;
      if (callNode && callNode.type === 'call_expression') {
        const argsText = callNode.childForFieldName('arguments')?.text ?? '';
        const m = /"([^"]*)"/.exec(argsText);
        if (m && m[1]) {
          const verbMatch = /HttpMethod::(\w+)/.exec(callNode.text);
          const span = spanOf(callNode);
          facts.routes.push({
            verb: verbMatch ? verbMatch[1].toUpperCase() : 'ANY',
            path: m[1],
            sl: span.sl,
            sb: span.sb,
            el: span.el,
            eb: span.eb,
            confidence: 'heuristic',
          });
        }
      }
      continue;
    }

    if (caps.has('loc.name')) {
      facts.locals.push({ name: capText(caps, 'loc.name'), sb: caps.get('loc.name').node.startIndex });
      continue;
    }

    if (caps.has('cl.id') || caps.has('cl.scoped') || caps.has('cl.field')) {
      let calleeNode = caps.get('cl.id')?.node ?? null;
      let segments = null;
      if (caps.has('cl.scoped')) {
        calleeNode = caps.get('cl.scoped').node;
        segments = splitPath(calleeNode.text);
      } else if (caps.has('cl.field')) {
        calleeNode = caps.get('cl.field').node;
        const segs = [];
        let cur = calleeNode;
        while (cur && cur.type === 'field_expression') {
          const field = cur.childForFieldName('field');
          if (!field) break;
          segs.unshift(field.text);
          cur = cur.childForFieldName('value');
        }
        if (cur && (cur.type === 'identifier' || cur.type === 'scoped_identifier')) {
          const tail = cur.type === 'scoped_identifier' ? splitPath(cur.text) : [cur.text];
          segments = [...tail, ...segs];
        }
      } else {
        segments = [calleeNode.text];
      }
      if (!segments || segments.length === 0) continue;
      facts.calls.push({
        calleeText: segments.join('.'),
        head: segments[0],
        prop: segments.length > 1 ? segments[segments.length - 1] : null,
        selfRef: false,
        isNew: false,
        sb: calleeNode.startIndex,
      });
      continue;
    }

    const fam =
      caps.has('fn.def') ? { key: 'fn', kind: 'function', nameCap: 'fn.name', paramsCap: 'fn.params' }
      : caps.has('fsig.def') ? { key: 'fsig', kind: 'method', nameCap: 'fsig.name', paramsCap: 'fsig.params' }
      : caps.has('st.def') ? { key: 'st', kind: 'class', nameCap: 'st.name' }
      : caps.has('en.def') ? { key: 'en', kind: 'enum', nameCap: 'en.name' }
      : caps.has('un.def') ? { key: 'un', kind: 'type', nameCap: 'un.name' }
      : caps.has('ty.def') ? { key: 'ty', kind: 'type', nameCap: 'ty.name' }
      : caps.has('tr.def') ? { key: 'tr', kind: 'interface', nameCap: 'tr.name' }
      : caps.has('md.def') ? { key: 'md', kind: 'module', nameCap: 'md.name' }
      : caps.has('im.def') && !seenImplNodes.has(caps.get('im.def').node.id)
        ? { key: 'im', kind: 'impl', nameCap: null }
      : caps.has('im2.def') && !seenImplNodes.has(caps.get('im2.def').node.id)
        ? { key: 'im2', kind: 'impl', nameCap: null, typeCap: 'im2.type' }
      : null;
    if (!fam) continue;

    const defNode = caps.get(`${fam.key}.def`).node;
    if (fam.kind === 'impl') seenImplNodes.add(defNode.id);

    let name;
    let traitText = null;
    if (fam.key === 'im') {
      const traitNode = caps.get('im.trait')?.node ?? null;
      const typeNode = caps.get('im.type')?.node ?? null;
      traitText = traitNode ? collapseWs(traitNode.text) : null;
      const typeText = typeNode ? collapseWs(typeNode.text) : '?';
      name = traitText ? `${traitText} for ${typeText}` : `impl ${typeText}`;
    } else if (fam.key === 'im2') {
      const typeNode = caps.get('im2.type')?.node ?? null;
      name = `impl ${typeNode ? collapseWs(typeNode.text) : '?'}`;
    } else {
      name = capText(caps, fam.nameCap);
    }
    if (!name) continue;

    const paramsCap = fam.paramsCap ? caps.get(fam.paramsCap) : null;
    const paramsInner = paramsCap ? collapseWs(paramsCap.node.text.replace(/^\(/, '').replace(/\)$/, '')) : '';

    let sig;
    if (fam.kind === 'function' || fam.kind === 'method') sig = `${name}(${paramsInner})`;
    else sig = name;

    const { attributes, comments } = precedingRustDocAndAttrs(defNode);

    const def = {
      kind: fam.kind,
      name,
      ...spanOf(defNode),
      sig,
      sigHash: sha256Hex(sig).slice(0, 16),
      exported: [...defNode.children].some((c) => c && c.type === 'visibility_modifier'),
      decorators: attributes,
      summary: docSummaryFromComments(comments),
      lang: 'rust',
      paramTokens: paramsCap ? [...new Set(identTokens(paramsCap.node.text))] : [],
      _heritage:
        fam.key === 'im' && traitText
          ? [{ rel: 'implements', name: traitText }]
          : [],
    };
    rawDefs.push(def);

    if (fam.kind === 'function' || fam.kind === 'method') {
      const spanD = spanOf(defNode);
      for (const attr of attributes) {
        const m = /^#\[\s*(get|post|put|patch|delete|route)\s*\(\s*"([^"]*)"/i.exec(attr);
        if (!m) continue;
        let verb = m[1].toUpperCase();
        if (verb === 'ROUTE') {
          const mm = /method\s*=\s*"(\w+)"/i.exec(attr);
          verb = mm ? mm[1].toUpperCase() : 'ANY';
        }
        facts.routes.push({
          verb,
          path: m[2],
          sl: spanD.sl,
          sb: spanD.sb,
          el: spanD.el,
          eb: spanD.eb,
          confidence: 'exact',
        });
      }
    }
  }

  const defs = finalizeDefs(rawDefs);
  facts.defs = defs;

  for (const def of defs) {
    const idx = enclosingDefIndex(defs, def.sb, def.key);
    if (idx >= 0) def.ownerKey = defs[idx].key;
    def.heritage = [];
    if (def._heritage) {
      for (const h of def._heritage) {
        if (h.name) {
          facts.heritage.push({ defKey: def.key, rel: h.rel, name: h.name });
          def.heritage.push({ rel: h.rel, name: h.name });
        }
      }
      delete def._heritage;
    }
  }

  for (const call of facts.calls) {
    const idx = enclosingDefIndex(defs, call.sb);
    call.defKey = idx >= 0 ? defs[idx].key : null;
  }

  for (const route of facts.routes) {
    const idx = enclosingDefIndex(defs, route.sb);
    route.defKey = idx >= 0 ? defs[idx].key : null;
  }

  return facts;
}
