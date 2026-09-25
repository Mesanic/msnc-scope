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

const HTTP_ATTR_RE = /^Http(Get|Post|Put|Patch|Delete)$/;
const TEST_FRAMEWORK_NS = /^(Xunit|NUnit|Microsoft\.VisualStudio\.TestTools\.Testing)/;

function precedingCSharpDoc(node) {
  const comments = [];
  let n = node.previousNamedSibling;
  while (n && (n.type === 'single_line_comment' || n.type === 'multi_line_comment' || n.type === 'comment')) {
    comments.unshift(n.text);
    n = n.previousNamedSibling;
  }
  const doc = [...comments].reverse().find((c) => c.trimStart().startsWith('///'));
  if (!doc) return null;
  return firstParagraph(
    doc
      .split('\n')
      .map((l) => l.replace(/^\s*\/\/\/\s?/, '').replace(/^\s*<summary>/i, '').replace(/<\/summary>\s*$/i, '').trim())
      .filter(Boolean)
      .join(' '),
  );
}

function attributesOf(defNode) {
  const out = [];
  for (let i = 0; i < defNode.childCount; i++) {
    const c = defNode.child(i);
    if (!c || !c.isNamed || c.type !== 'attribute_list') continue;
    for (let j = 0; j < c.childCount; j++) {
      const a = c.child(j);
      if (a && a.isNamed && a.type === 'attribute') out.push(`[${collapseWs(a.text)}]`);
    }
  }
  return out;
}

function typeNamesInBaseList(node) {
  const out = [];
  if (!node) return out;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c || !c.isNamed) continue;
    if (c.type === 'identifier' || c.type === 'qualified_name') {
      out.push(c.text.replace(/\s+/g, ''));
      continue;
    }
    if (c.type === 'primary_constructor_base_type') {
      const t = c.childForFieldName('type');
      if (t) out.push(t.text.replace(/\s+/g, ''));
    }
  }
  return out;
}

export function extractCSharp(posixPath, text, tree, query) {
  const facts = emptyFacts();
  facts.lineCount = text.split('\n').length;
  const rawDefs = [];
  let classRoutePrefix = null;

  for (const match of query.matches(tree.rootNode)) {
    const caps = capMap(match.captures);

    if (caps.has('us.stmt')) {
      const stmt = caps.get('us.stmt').node;
      let spec = null;
      let isStatic = false;
      let isGlobal = false;
      for (let i = 0; i < stmt.childCount; i++) {
        const c = stmt.child(i);
        if (!c) continue;
        if (!c.isNamed) {
          if (c.text === 'static') isStatic = true;
          if (c.text === 'global') isGlobal = true;
          continue;
        }
        if (['identifier', 'qualified_name', 'alias_qualified_name', 'generic_name'].includes(c.type)) {
          spec = c.text.replace(/\s+/g, '');
        }
      }
      if (spec) {
        const normalized = spec.replace(/^global::/, '');
        facts.imports.push({
          spec: normalized,
          names: [],
          ns: null,
          defaultAlias: null,
          level: 0,
          static: isStatic,
          global: isGlobal,
        });
        if (TEST_FRAMEWORK_NS.test(normalized)) facts.testFramework = true;
      }
      continue;
    }

    if (caps.has('ns.name') || caps.has('fns.name')) {
      const nameCap = caps.has('fns.name') ? caps.get('fns.name') : caps.get('ns.name');
      facts.namespace = nameCap.node.text.replace(/\s+/g, '');
      continue;
    }

    if (caps.has('ra.def')) {
      const defNode = caps.get('ra.def').node;
      const attrName = capText(caps, 'ra.name');
      const rawPath = caps.get('ra.path')?.node?.text ?? '';
      const pathText = rawPath.replace(/^"|"$/g, '');
      let verb = 'ANY';
      const m = HTTP_ATTR_RE.exec(attrName);
      if (m) verb = m[1].toUpperCase();
      else if (/^Route$/.test(attrName) && enclosingIsMethod(defNode)) verb = 'ANY';
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
      continue;
    }

    if (caps.has('ra0.def')) {
      const defNode = caps.get('ra0.def').node;
      const attrName = capText(caps, 'ra0.name');
      const m = HTTP_ATTR_RE.exec(attrName);
      if (m) {
        const attrNode = caps.get('ra0.name').node.parent;
        const hasArgs =
          attrNode &&
          [...attrNode.children].some((c) => c && c.isNamed && c.type === 'attribute_argument_list');
        if (!hasArgs) {
          const span = spanOf(defNode);
          facts.routes.push({
            verb: m[1].toUpperCase(),
            path: '',
            sl: span.sl,
            sb: span.sb,
            el: span.el,
            eb: span.eb,
            confidence: 'exact',
          });
        }
      }
      continue;
    }

    if (caps.has('cra.def')) {
      const rawPath = capText(caps, 'cra.path') ?? '';
      classRoutePrefix = rawPath.replace(/^"|"$/g, '');
      facts.routePrefix = classRoutePrefix;
      continue;
    }

    if (caps.has('loc.name')) {
      facts.locals.push({ name: capText(caps, 'loc.name'), sb: caps.get('loc.name').node.startIndex });
      continue;
    }

    if (caps.has('cl.id') || caps.has('cl.mem')) {
      let segments;
      let sb;
      if (caps.has('cl.mem')) {
        const memNode = caps.get('cl.mem').node;
        segments = flattenMemberAccess(memNode);
        sb = memNode.startIndex;
      } else {
        const idNode = caps.get('cl.id').node;
        segments = [idNode.text];
        sb = idNode.startIndex;
      }
      if (!segments) continue;
      facts.calls.push({
        calleeText: segments.join('.'),
        head: segments[0],
        prop: segments.length > 1 ? segments[segments.length - 1] : null,
        selfRef: segments[0] === 'this',
        isNew: false,
        sb,
      });
      continue;
    }

    if (caps.has('nw.t')) {
      const tNode = caps.get('nw.t').node;
      const ctorNode = tNode.parent;
      const span = spanOf(ctorNode ?? tNode);
      const nameText = tNode.text.replace(/\s+/g, '');
      facts.calls.push({
        calleeText: `new ${nameText}`,
        head: nameText.split('.').pop(),
        prop: null,
        selfRef: false,
        isNew: true,
        sb: span.sb,
      });
      continue;
    }

    const fam =
      caps.has('cls.def') ? { key: 'cls', kind: 'class', nameCap: 'cls.name' }
      : caps.has('iface.def') ? { key: 'iface', kind: 'interface', nameCap: 'iface.name' }
      : caps.has('st.def') ? { key: 'st', kind: 'class', nameCap: 'st.name' }
      : caps.has('rec.def') ? { key: 'rec', kind: 'class', nameCap: 'rec.name' }
      : caps.has('enum.def') ? { key: 'enum', kind: 'enum', nameCap: 'enum.name' }
      : caps.has('m.def') ? { key: 'm', kind: 'method', nameCap: 'm.name', paramsCap: 'm.params' }
      : null;
    if (!fam) continue;

    const defNode = caps.get(`${fam.key}.def`).node;
    const name = capText(caps, fam.nameCap);
    const paramsCap = fam.paramsCap ? caps.get(fam.paramsCap) : null;
    const paramsInner = paramsCap
      ? collapseWs(paramsCap.node.text.replace(/^\(/, '').replace(/\)$/, ''))
      : '';
    const sig = `${name}(${paramsInner})`;

    const heritage = [];
    const basesCap = fam.key === 'cls' ? caps.get('cls.bases') : fam.key === 'iface' ? caps.get('iface.bases') : null;
    const baseTypes = typeNamesInBaseList(basesCap?.node ?? null);
    if (fam.key === 'iface') {
      for (const b of baseTypes) heritage.push({ rel: 'extends', name: b });
    } else {
      baseTypes.forEach((b, i) => heritage.push({ rel: i === 0 ? 'extends' : 'implements', name: b }));
    }

    const modifiersText = modifiersOf(defNode);

    rawDefs.push({
      kind: fam.kind,
      name,
      ...spanOf(defNode),
      sig,
      sigHash: sha256Hex(sig).slice(0, 16),
      exported: !/\bprivate\b/.test(modifiersText),
      decorators: attributesOf(defNode),
      summary: precedingCSharpDoc(defNode),
      lang: 'c-sharp',
      paramTokens: paramsCap ? [...new Set(identTokens(paramsCap.node.text))] : [],
      _heritage: heritage,
      isController: /Controller$/.test(name),
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

  for (const route of facts.routes) {
    const idx = enclosingDefIndex(defs, route.sb);
    route.defKey = idx >= 0 ? defs[idx].key : null;
    const prefix = classRoutePrefix ?? '';
    if (prefix && route.path && !route.path.startsWith('/') && !route.path.startsWith('~')) {
      route.path = `${prefix}/${route.path}`;
    } else if (prefix && route.path.startsWith('/')) {
      route.path = `${prefix}${route.path}`;
    } else if (prefix && !route.path) {
      route.path = prefix;
    }
  }

  const routedMethodKeys = new Set(
    facts.routes.map((r) => r.defKey).filter((k) => k && k.length > 0),
  );
  const routedClassKeys = new Set();
  for (const def of defs) {
    if (!def.isController) continue;
    routedClassKeys.add(def.key);
  }
  for (const def of defs) {
    if (def.kind !== 'method' || !def.ownerKey) continue;
    if (!routedClassKeys.has(def.ownerKey)) continue;
    if (routedMethodKeys.has(def.key)) continue;
    if (!def.exported) continue;
    const ownerDef = defs.find((d) => d.key === def.ownerKey);
    if (!ownerDef) continue;
    const controllerBase = ownerDef.name.replace(/Controller$/, '');
    facts.routes.push({
      verb: 'ANY',
      path: `/${controllerBase}/${def.name}`,
      sl: def.sl,
      sb: def.sb,
      el: def.el,
      eb: def.eb,
      confidence: 'heuristic',
      defKey: def.key,
    });
  }

  return facts;
}

function enclosingIsMethod(defNode) {
  return defNode.parent?.type === 'method_declaration';
}

function modifiersOf(defNode) {
  for (let i = 0; i < defNode.childCount; i++) {
    const c = defNode.child(i);
    if (c && c.isNamed && c.type === 'modifier') return c.text;
  }
  return '';
}

function flattenMemberAccess(node) {
  const segments = [];
  let cur = node;
  while (cur && cur.type === 'member_access_expression') {
    const name = cur.childForFieldName('name');
    if (!name) return null;
    segments.unshift(name.text);
    cur = cur.childForFieldName('expression');
  }
  if (!cur) return null;
  if (cur.type === 'identifier' || cur.type === 'generic_name') {
    const inner = cur.type === 'generic_name' ? cur.childForFieldName('identifier') : cur;
    segments.unshift(inner ? inner.text : cur.text);
  } else if (cur.type === 'predefined_type' || cur.type === 'qualified_name' || cur.type === 'alias_qualified_name') {
    segments.unshift(cur.text.replace(/\s+/g, ''));
  } else if (cur.type === 'this_expression') {
    segments.unshift('this');
  } else {
    return null;
  }
  return segments;
}
