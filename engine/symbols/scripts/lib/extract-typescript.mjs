import { collapseWs, sha256Hex } from './util.mjs';
import {
  ancestorsInclude,
  capMap,
  capText,
  collectInnerDecorators,
  emptyFacts,
  enclosingDefIndex,
  finalizeDefs,
  flattenMemberChain,
  identTokens,
  precedingDecoratorsAndComment,
  spanOf,
  stripJsdoc,
  unquote,
} from './extract-util.mjs';

export function extractTypescript(posixPath, text, tree, query) {
  const facts = emptyFacts();
  facts.lineCount = text.split('\n').length;
  const rawDefs = [];
  const requireDeclaratorNameStarts = new Set();

  for (const match of query.matches(tree.rootNode)) {
    const caps = capMap(match.captures);

    if (caps.has('im.src')) {
      const stmt = caps.get('im.stmt').node;
      const imp = { spec: unquote(capText(caps, 'im.src')), names: [], ns: null, defaultAlias: null, level: 0 };
      let clause = null;
      for (let i = 0; i < stmt.childCount; i++) {
        const c = stmt.child(i);
        if (c && c.isNamed && c.type === 'import_clause') {
          clause = c;
          break;
        }
      }
      if (clause) {
        for (let i = 0; i < clause.childCount; i++) {
          const c = clause.child(i);
          if (!c || !c.isNamed) continue;
          if (c.type === 'identifier') imp.defaultAlias = c.text;
          else if (c.type === 'namespace_import') {
            for (let j = 0; j < c.childCount; j++) {
              const cc = c.child(j);
              if (cc && cc.type === 'identifier') imp.ns = cc.text;
            }
          } else if (c.type === 'named_imports') {
            for (let j = 0; j < c.childCount; j++) {
              const spec = c.child(j);
              if (!spec || spec.type !== 'import_specifier') continue;
              const nameNode = spec.childForFieldName('name');
              const aliasNode = spec.childForFieldName('alias');
              if (nameNode) imp.names.push({ name: nameNode.text, alias: aliasNode ? aliasNode.text : null });
            }
          }
        }
      }
      facts.imports.push(imp);
      continue;
    }

    if (caps.has('rx.src')) {
      const stmt = caps.get('rx.stmt').node;
      const rex = { spec: unquote(capText(caps, 'rx.src')), entries: [], wildcard: false };
      for (let i = 0; i < stmt.childCount; i++) {
        const c = stmt.child(i);
        if (!c) continue;
        if (c.type === '*' && !c.isNamed) rex.wildcard = true;
        if (c.type === 'export_clause') {
          for (let j = 0; j < c.childCount; j++) {
            const spec = c.child(j);
            if (!spec || spec.type !== 'export_specifier') continue;
            const nameNode = spec.childForFieldName('name');
            const aliasNode = spec.childForFieldName('alias');
            if (nameNode) {
              rex.entries.push({
                exported: aliasNode ? aliasNode.text : nameNode.text,
                origin: nameNode.text,
              });
            }
          }
        }
      }
      facts.reexports.push(rex);
      continue;
    }

    if (caps.has('rq.src')) {
      const decl = caps.has('rq.decl') ? caps.get('rq.decl').node : null;
      const propCap = caps.get('rq.prop'); // member-access require: require('./m').prop
      let alias = null;
      let names = [];
      if (decl) {
        const nameNode = decl.childForFieldName('name');
        if (nameNode) {
          if (nameNode.type === 'identifier') {
            alias = nameNode.text;
            // Both plain and member-access requires introduce an import-backed
            // local, not a true shadow: exclude it from locals.
            requireDeclaratorNameStarts.add(nameNode.startIndex);
            if (propCap) {
              // var X = require('./m').prop  ≙  import { prop as X }
              names = [{ name: propCap.node.text, alias }];
              alias = null;
            }
          } else if (nameNode.type === 'object_pattern') {
            for (let j = 0; j < nameNode.childCount; j++) {
              const pc = nameNode.child(j);
              if (!pc || !pc.isNamed) continue;
              if (pc.type === 'shorthand_property_identifier_pattern') names.push({ name: pc.text, alias: null });
            }
          }
        }
      }
      facts.imports.push({
        spec: unquote(capText(caps, 'rq.src')),
        names,
        ns: alias,
        defaultAlias: null,
        level: 0,
      });
      continue;
    }

    if (caps.has('rq2.src')) {
      facts.imports.push({ spec: unquote(capText(caps, 'rq2.src')), names: [], ns: null, defaultAlias: null, level: 0 });
      continue;
    }

    if (caps.has('rt.path')) {
      const propNode = caps.get('rt.method').node;
      const callNode = propNode.parent?.parent;
      const span = callNode ? spanOf(callNode) : spanOf(propNode);
      facts.routes.push({
        verb: capText(caps, 'rt.method').toUpperCase(),
        path: unquote(capText(caps, 'rt.path')),
        sl: span.sl,
        sb: span.sb,
        el: span.el,
        eb: span.eb,
      });
      continue;
    }

    if (caps.has('loc.name')) {
      facts.locals.push({ name: capText(caps, 'loc.name'), sb: caps.get('loc.name').node.startIndex });
      continue;
    }

    if (caps.has('cl.id') || caps.has('cl.mem')) {
      const isMember = caps.has('cl.mem');
      const calleeNode = isMember ? caps.get('cl.mem').node : caps.get('cl.id').node;
      const segments = isMember ? flattenMemberChain(calleeNode, 'member_expression', 'property_identifier') : [calleeNode.text];
      if (!segments) continue;
      facts.calls.push({
        calleeText: segments.join('.'),
        head: segments[0],
        prop: segments.length > 1 ? segments[segments.length - 1] : null,
        selfRef: segments[0] === 'this',
        isNew: false,
        sb: calleeNode.startIndex,
      });
      continue;
    }

    if (caps.has('nw.id') || caps.has('nw.mem')) {
      const isMember = caps.has('nw.mem');
      const ctorNode = isMember ? caps.get('nw.mem').node : caps.get('nw.id').node;
      const segments = isMember ? flattenMemberChain(ctorNode, 'member_expression', 'property_identifier') : [ctorNode.text];
      if (!segments) continue;
      facts.calls.push({
        calleeText: segments.join('.'),
        head: segments[0],
        prop: segments.length > 1 ? segments[segments.length - 1] : null,
        selfRef: segments[0] === 'this',
        isNew: true,
        sb: ctorNode.startIndex,
      });
      continue;
    }

    // CommonJS export assignments: (module.)exports.NAME = function|arrow.
    // The object identifier is predicate-matched in the query (^(exports|module)$).
    if (caps.has('xffn.obj') || caps.has('xfar.obj')) {
      const famX = caps.has('xffn.name') ? 'xffn' : 'xfar';
      const defNode = caps.get(`${famX}.def`).node;
      const name = capText(caps, `${famX}.name`);
      const paramsCap = caps.get(`${famX}.params`);
      const retCap = caps.get(`${famX}.ret`);
      const paramsInner = paramsCap ? collapseWs(paramsCap.node.text.replace(/^\(/, '').replace(/\)$/, '')) : '';
      const ret = retCap ? collapseWs(retCap.node.text.replace(/^:/, '')) : '';
      let sig = `${name}(${paramsInner})`;
      if (ret) sig += `: ${ret}`;
      // anchor = the expression_statement so a preceding JSDoc block is found
      const stmtAnchor = (() => {
        let n = defNode.parent; // assignment_expression
        while (n && n.type !== 'expression_statement' && n.parent) {
          if (n.type === 'expression_statement') break;
          n = n.parent;
        }
        return n ?? defNode;
      })();
      const { comments } = precedingDecoratorsAndComment(stmtAnchor);
      rawDefs.push({
        kind: 'function',
        name,
        ...spanOf(defNode),
        sig,
        sigHash: sha256Hex(sig).slice(0, 16),
        exported: true, // exports.NAME / module.exports.NAME are exports by construction
        decorators: [],
        summary: comments.length ? stripJsdoc(comments[comments.length - 1]) : null,
        lang: 'typescript',
        paramTokens: paramsCap ? [...new Set(identTokens(paramsCap.node.text))] : [],
        _heritageNode: null,
      });
      continue;
    }

    const fam =
      caps.has('fn.name') ? 'fn'
      : caps.has('gfn.name') ? 'gfn'
      : caps.has('m.name') ? 'm'
      : caps.has('af.name') ? 'af'
      : caps.has('cls.name') ? 'cls'
      : caps.has('acls.name') ? 'acls'
      : caps.has('iface.name') ? 'iface'
      : caps.has('enum.name') ? 'enum'
      : caps.has('type.name') ? 'type'
      : null;

    if (!fam) continue;

    const kind =
      fam === 'fn' || fam === 'gfn' || fam === 'af' ? 'function'
      : fam === 'm' ? 'method'
      : fam === 'cls' || fam === 'acls' ? 'class'
      : fam === 'iface' ? 'interface'
      : fam === 'enum' ? 'enum'
      : 'type';

    const defNode = caps.get(`${fam}.def`).node;
    const name = capText(caps, `${fam}.name`);
    const paramsCap = caps.get(`${fam}.params`);
    const retCap = caps.get(`${fam}.ret`);
    const tpCap = caps.get(`${fam}.tp`);
    const heritageCap = caps.get(`${fam}.h`);

    const paramsNode = paramsCap ? paramsCap.node : null;
    const paramsInner = paramsNode ? collapseWs(paramsNode.text.replace(/^\(/, '').replace(/\)$/, '')) : '';
    const ret = retCap ? collapseWs(retCap.node.text.replace(/^:/, '')) : '';
    const tp = tpCap ? collapseWs(tpCap.node.text) : '';

    let sig;
    if (kind === 'class' || kind === 'interface' || kind === 'type') {
      sig = `${name}${tp}`;
    } else {
      sig = `${name}(${paramsInner})`;
      if (ret) sig += `: ${ret}`;
    }

    const anchor = defNode.parent && defNode.parent.type === 'export_statement' ? defNode.parent : defNode;
    const { comments } = precedingDecoratorsAndComment(anchor);
    const decorators = collectInnerDecorators(defNode, anchor);

    rawDefs.push({
      kind,
      name,
      ...spanOf(defNode),
      sig,
      sigHash: sha256Hex(sig).slice(0, 16),
      exported: ancestorsInclude(defNode, 'export_statement'),
      decorators,
      summary: comments.length ? stripJsdoc(comments[comments.length - 1]) : null,
      lang: 'typescript',
      paramTokens: paramsNode ? [...new Set(identTokens(paramsNode.text))] : [],
      _heritageNode: heritageCap ? heritageCap.node : null,
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
    if (!def._heritageNode) continue;
    for (let i = 0; i < def._heritageNode.childCount; i++) {
      const clause = def._heritageNode.child(i);
      if (!clause || !clause.isNamed) continue;
      const rel = clause.type === 'extends_clause' ? 'extends' : clause.type === 'implements_clause' ? 'implements' : null;
      if (!rel) continue;
      for (let j = 0; j < clause.childCount; j++) {
        const t = clause.child(j);
        if (!t || !t.isNamed) continue;
        if (t.type === 'identifier' || t.type === 'member_expression' || t.type === 'type_identifier') {
          const segs = t.type === 'member_expression' ? flattenMemberChain(t, 'member_expression', 'property_identifier') : [t.text];
          if (segs) facts.heritage.push({ defKey: def.key, rel, name: segs.join('.') });
        }
      }
    }
    delete def._heritageNode;
  }

  for (const route of facts.routes) {
    const idx = enclosingDefIndex(defs, route.sb);
    route.defKey = idx >= 0 ? defs[idx].key : null;
  }

  if (requireDeclaratorNameStarts.size > 0) {
    facts.locals = facts.locals.filter((l) => !requireDeclaratorNameStarts.has(l.sb));
  }

  return facts;
}
