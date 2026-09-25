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

function stripQuotes(text) {
  const t = String(text ?? '');
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

function precedingGoDoc(node) {
  const comments = [];
  let n = node.previousNamedSibling;
  while (n && n.type === 'comment') {
    comments.unshift(n.text);
    n = n.previousNamedSibling;
  }
  if (comments.length === 0) return null;
  return firstParagraph(
    comments[comments.length - 1]
      .split('\n')
      .map((l) => l.replace(/^\s*\/\/\s?/, '').trimEnd())
      .join('\n'),
  );
}

function selectorSegments(node) {
  if (!node) return null;
  if (node.type === 'identifier') return [node.text];
  if (node.type === 'selector_expression') {
    const head = selectorSegments(node.childForFieldName('operand'));
    const field = node.childForFieldName('field');
    if (!head || !field) return null;
    return [...head, field.text];
  }
  return null;
}

export function extractGo(posixPath, text, tree, query) {
  const facts = emptyFacts();
  facts.lineCount = text.split('\n').length;
  const rawDefs = [];
  const seenDefNodes = new Set();

  for (const match of query.matches(tree.rootNode)) {
    const caps = capMap(match.captures);

    if (caps.has('pkg.name')) {
      facts.packageName = capText(caps, 'pkg.name');
      continue;
    }

    if (caps.has('im.path')) {
      const stmt = caps.get('im.stmt').node;
      const specNode = caps.get('im.path').node;
      const specStmt = specNode.parent;
      const imp = {
        spec: stripQuotes(specNode.text),
        names: [],
        ns: null,
        defaultAlias: null,
        level: 0,
      };
      if (specStmt && specStmt.type === 'import_spec') {
        const alias = specStmt.childForFieldName('name');
        if (alias) {
          if (alias.type === 'package_identifier') imp.ns = alias.text;
          else if (alias.type === 'dot') imp.dot = true;
          else if (alias.type === 'blank_identifier') imp.blank = true;
        }
      }
      facts.imports.push(imp);
      void stmt;
      continue;
    }

    if (caps.has('rt.path')) {
      const pathNode = caps.get('rt.path').node;
      const callNode = pathNode.parent?.parent;
      const span = callNode ? spanOf(callNode) : spanOf(pathNode);
      let verb = capText(caps, 'rt.method').toUpperCase();
      if (verb === 'ANY') verb = 'ANY';
      facts.routes.push({
        verb,
        path: stripQuotes(capText(caps, 'rt.path')),
        sl: span.sl,
        sb: span.sb,
        el: span.el,
        eb: span.eb,
        confidence: 'heuristic',
      });
      continue;
    }

    if (caps.has('loc.name')) {
      facts.locals.push({ name: capText(caps, 'loc.name'), sb: caps.get('loc.name').node.startIndex });
      continue;
    }

    if (caps.has('cl.id') || caps.has('cl.head') || caps.has('cl.chain')) {
      let segments = null;
      if (caps.has('cl.chain')) segments = selectorSegments(caps.get('cl.chain').node);
      else if (caps.has('cl.head')) {
        const prop = capText(caps, 'cl.prop');
        segments = [capText(caps, 'cl.head'), ...(prop ? [prop] : [])];
      } else segments = [capText(caps, 'cl.id')];
      if (!segments || segments.length === 0) continue;
      facts.calls.push({
        calleeText: segments.join('.'),
        head: segments[0],
        prop: segments.length > 1 ? segments[segments.length - 1] : null,
        selfRef: false,
        isNew: false,
        sb: caps.get('cl.id')?.node.startIndex ?? caps.get('cl.head')?.node.startIndex ?? caps.get('cl.chain').node.startIndex,
      });
      continue;
    }

    const fam =
      caps.has('fn.def') ? 'fn'
      : caps.has('m.def') ? 'm'
      : caps.has('cls.spec') ? 'cls'
      : caps.has('iface.spec') ? 'iface'
      : null;
    if (!fam) continue;

    const defNode =
      fam === 'fn' ? caps.get('fn.def').node
      : fam === 'm' ? caps.get('m.def').node
      : caps.get(fam === 'cls' ? 'cls.spec' : 'iface.spec')?.parent?.parent?.type === 'type_declaration'
        ? caps.get(fam === 'cls' ? 'cls.spec' : 'iface.spec').node
        : caps.get(fam === 'cls' ? 'cls.spec' : 'iface.spec').node;
    const seenKey = defNode.id + ':' + fam;
    if (seenDefNodes.has(seenKey)) continue;
    seenDefNodes.add(seenKey);

    const nameCap = fam === 'fn' ? caps.get('fn.name') : fam === 'm' ? caps.get('m.name') : caps.get(`${fam}.name`);
    const name = nameCap.node.text;
    const paramsCap = fam === 'fn' ? caps.get('fn.params') : fam === 'm' ? caps.get('m.params') : null;

    const paramsInner = paramsCap ? collapseWs(paramsCap.node.text.replace(/^\(/, '').replace(/\)$/, '')) : '';
    const sig = `${name}(${paramsInner})`;

    const kind =
      fam === 'fn' ? 'function'
      : fam === 'm' ? 'method'
      : fam === 'cls' ? 'class'
      : 'interface';

    const def = {
      kind,
      name,
      ...spanOf(defNode),
      sig,
      sigHash: sha256Hex(sig).slice(0, 16),
      exported: /^[A-Z]/.test(name),
      decorators: [],
      summary: precedingGoDoc(defNode),
      lang: 'go',
      paramTokens: paramsCap ? [...new Set(identTokens(paramsCap.node.text))] : [],
    };

    if (fam === 'm') {
      const recv = caps.get('m.recv').node;
      const typeNodes = [];
      const walk = (n) => {
        if (!n || !n.isNamed) return;
        if (n.type === 'type_identifier') typeNodes.push(n);
        for (let i = 0; i < n.childCount; i++) walk(n.child(i));
      };
      walk(recv);
      def.receiverType = typeNodes.length > 0 ? typeNodes[typeNodes.length - 1].text : null;
    }

    if (fam === 'iface') {
      const ifaceType = caps.get('iface.spec').node.childForFieldName('type');
      const methods = [];
      const walk = (n) => {
        if (!n || !n.isNamed) return;
        if (n.type === 'method_elem') {
          for (let i = 0; i < n.childCount; i++) {
            const c = n.child(i);
            if (c && c.isNamed && c.type === 'field_identifier') {
              methods.push(c.text);
              break;
            }
          }
        }
        for (let i = 0; i < n.childCount; i++) walk(n.child(i));
      };
      if (ifaceType) walk(ifaceType);
      def.ifaceMethods = methods;
    }

    rawDefs.push(def);
  }

  const defs = finalizeDefs(rawDefs);
  facts.defs = defs;

  const classByName = new Map();
  for (const def of defs) {
    if (def.kind === 'class') classByName.set(def.name, def.key);
  }
  for (const def of defs) {
    const idx = enclosingDefIndex(defs, def.sb, def.key);
    if (idx >= 0) def.ownerKey = defs[idx].key;
    else if (def.kind === 'method' && def.receiverType && classByName.has(def.receiverType)) {
      def.ownerKey = classByName.get(def.receiverType);
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
