import { collapseWs, sha256Hex } from './util.mjs';
import {
  capMap,
  capText,
  docstringFromBody,
  emptyFacts,
  enclosingDefIndex,
  finalizeDefs,
  findAncestor,
  flattenMemberChain,
  identTokens,
  spanOf,
  stringContentOf,
  unquote,
} from './extract-util.mjs';

export function extractPython(posixPath, text, tree, query) {
  const facts = emptyFacts();
  facts.lineCount = text.split('\n').length;

  for (let i = 0; i < tree.rootNode.childCount; i++) {
    const child = tree.rootNode.child(i);
    if (!child || !child.isNamed) continue;
    if (child.type === 'expression_statement') {
      facts.moduleSummary = stringContentOf(child);
    }
    break;
  }

  const rawDefs = [];
  const seenDefNodes = new Set();

  const collectRouteOrDef = (match) => {
    const caps = capMap(match.captures);

    if (caps.has('rt.path') && caps.has('rt.def')) {
      const defNode = caps.get('rt.def').node;
      const callNode = caps.get('rt.path').node.parent?.parent?.parent;
      const span = callNode ? spanOf(callNode) : spanOf(defNode);
      let verb = capText(caps, 'rt.method').toUpperCase();
      if (verb === 'ROUTE') {
        const m = /methods\s*=\s*[\[({]([^\]})]*)[\])}]/.exec(callNode?.text ?? '');
        if (!m) {
          verb = 'GET';
        } else {
          // A methods list naming several HTTP verbs identifies no single
          // method: emitting the first would fabricate precision, so no route
          // fact is produced for that decorator.
          const verbs = [
            ...new Set([...m[1].matchAll(/["']([A-Za-z]+)["']/g)].map((x) => x[1].toUpperCase())),
          ];
          if (verbs.length !== 1) return;
          verb = verbs[0];
        }
      }
      facts.routes.push({
        verb,
        path: unquote(capText(caps, 'rt.path')),
        sl: span.sl,
        sb: span.sb,
        el: span.el,
        eb: span.eb,
        defNode,
      });
    }
  };

  for (const match of query.matches(tree.rootNode)) {
    collectRouteOrDef(match);
    const caps = capMap(match.captures);

    if (caps.has('im.stmt')) {
      const stmt = caps.get('im.stmt').node;
      let seenImportKw = false;
      for (let i = 0; i < stmt.childCount; i++) {
        const c = stmt.child(i);
        if (!c) continue;
        if (!c.isNamed && c.type === 'import') seenImportKw = true;
        if (!c.isNamed || !seenImportKw) continue;
        if (c.type === 'dotted_name') {
          facts.imports.push({ spec: c.text, names: [], ns: null, defaultAlias: null, level: 0 });
        } else if (c.type === 'aliased_import') {
          const dn = c.childForFieldName('name');
          const al = c.childForFieldName('alias');
          if (dn) facts.imports.push({ spec: dn.text, names: [], ns: al ? al.text : null, defaultAlias: null, level: 0 });
        }
      }
      continue;
    }

    if (caps.has('ifm.mod') || caps.has('ifm.rel')) {
      const stmt = caps.get('ifm.stmt').node;
      let level = 0;
      let moduleText = null;
      if (caps.has('ifm.rel')) {
        const rel = caps.get('ifm.rel').node;
        for (let i = 0; i < rel.childCount; i++) {
          const c = rel.child(i);
          if (!c) continue;
          if (c.type === 'import_prefix') level = (c.text.match(/\./g) ?? []).length;
          else if (c.type === 'dotted_name') moduleText = c.text;
        }
      } else {
        moduleText = capText(caps, 'ifm.mod');
      }
      const imp = { spec: moduleText ?? '', names: [], ns: null, defaultAlias: null, level, wildcard: false };
      let seenImportKw = false;
      for (let i = 0; i < stmt.childCount; i++) {
        const c = stmt.child(i);
        if (!c) continue;
        if (!c.isNamed && c.type === 'import') seenImportKw = true;
        if (!c.isNamed || !seenImportKw) continue;
        if (c.type === 'dotted_name') imp.names.push({ name: c.text, alias: null });
        else if (c.type === 'aliased_import') {
          const dn = c.childForFieldName('name');
          const al = c.childForFieldName('alias');
          if (dn) imp.names.push({ name: dn.text, alias: al ? al.text : null });
        } else if (c.type === 'wildcard_import') imp.wildcard = true;
      }
      facts.imports.push(imp);
      continue;
    }

    if (caps.has('loc.name')) {
      facts.locals.push({ name: capText(caps, 'loc.name'), sb: caps.get('loc.name').node.startIndex });
      continue;
    }

    if (caps.has('cl.id') || caps.has('cl.at')) {
      const isAttr = caps.has('cl.at');
      const calleeNode = isAttr ? caps.get('cl.at').node : caps.get('cl.id').node;
      const segments = isAttr ? flattenMemberChain(calleeNode, 'attribute', 'identifier') : [calleeNode.text];
      if (!segments) continue;
      facts.calls.push({
        calleeText: segments.join('.'),
        head: segments[0],
        prop: segments.length > 1 ? segments[segments.length - 1] : null,
        selfRef: segments[0] === 'self',
        isNew: false,
        sb: calleeNode.startIndex,
      });
      continue;
    }

    const defNode = caps.has('fn.def') ? caps.get('fn.def').node : caps.has('cls.def') ? caps.get('cls.def').node : null;
    if (!defNode || seenDefNodes.has(defNode.id)) continue;
    seenDefNodes.add(defNode.id);

    const isFn = caps.has('fn.def');
    const nameNode = defNode.childForFieldName('name');
    if (!nameNode) continue;
    const name = nameNode.text;
    const paramsNode = defNode.childForFieldName('parameters');
    const retNode = isFn ? defNode.childForFieldName('return_type') : null;
    const supersNode = isFn ? null : defNode.childForFieldName('superclasses');

    const paramsInner = paramsNode ? collapseWs(paramsNode.text.replace(/^\(/, '').replace(/\)$/, '')) : '';
    const ret = retNode ? collapseWs(retNode.text.replace(/^->/, '')) : '';

    let sig = `${name}(${paramsInner})`;
    if (ret) sig += ` -> ${ret}`;

    const decorators = [];
    const parent = defNode.parent;
    if (parent && parent.type === 'decorated_definition') {
      for (let i = 0; i < parent.childCount; i++) {
        const c = parent.child(i);
        if (c && c.isNamed && c.type === 'decorator') decorators.push(collapseWs(c.text));
      }
    }

    const inClass = Boolean(findAncestor(defNode, 'class_definition'));

    rawDefs.push({
      kind: isFn ? (inClass ? 'method' : 'function') : 'class',
      name,
      ...spanOf(defNode),
      sig,
      sigHash: sha256Hex(sig).slice(0, 16),
      exported: !name.startsWith('_'),
      decorators,
      summary: docstringFromBody(defNode.childForFieldName('body')),
      lang: 'python',
      paramTokens: paramsNode ? [...new Set(identTokens(paramsNode.text))] : [],
      _supersNode: supersNode,
    });
  }

  const defs = finalizeDefs(rawDefs);
  facts.defs = defs;

  for (const def of defs) {
    const idx = enclosingDefIndex(defs, def.sb, def.key);
    if (idx >= 0) def.ownerKey = defs[idx].key;
  }

  for (const call of facts.calls) {
    const idx = enclosingDefIndex(defs, call.sb);
    call.defKey = idx >= 0 ? defs[idx].key : null;
  }

  for (const def of defs) {
    if (!def._supersNode) continue;
    for (let i = 0; i < def._supersNode.childCount; i++) {
      const c = def._supersNode.child(i);
      if (!c || !c.isNamed) continue;
      if (c.type === 'identifier') facts.heritage.push({ defKey: def.key, rel: 'extends', name: c.text });
      else if (c.type === 'attribute') {
        const segs = flattenMemberChain(c, 'attribute', 'identifier');
        if (segs) facts.heritage.push({ defKey: def.key, rel: 'extends', name: segs.join('.') });
      }
    }
    delete def._supersNode;
  }

  for (const route of facts.routes) {
    const idx = route.defNode ? enclosingDefIndex(defs, route.defNode.startIndex) : enclosingDefIndex(defs, route.sb);
    route.defKey = idx >= 0 ? defs[idx].key : null;
    delete route.defNode;
  }

  return facts;
}
