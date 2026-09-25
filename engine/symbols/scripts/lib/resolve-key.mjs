import { UsageError } from './usage-error.mjs';

export const NODE_ID_RE = /^(fn|method|cls|iface|type|enum|mod|route):[0-9a-f]{12}$/;
const RANGE_RE = /^([^:\\]+):(\d+)(?:-(\d+))?$/;

/**
 * Resolve a user-supplied key to a concrete target.
 *
 * Accepted forms (in priority order):
 *   1. node id            e.g. `fn:1a2b3c4d5e6f`
 *   2. path:a-b | path:a  e.g. `src/util.ts:7-9` (slice only; POSIX, repo-relative)
 *   3. bare symbol name   e.g. `getUserById` — must match exactly one definition
 *
 * Returns { kind: 'node', node } or { kind: 'range', path, sl, el }.
 * Throws UsageError for unknown/ambiguous keys with deterministic candidate lists.
 */
export function resolveKey(store, rawKey, { allowRange = true } = {}) {
  const key = String(rawKey ?? '').trim();
  if (!key) throw new UsageError('a symbol key is required (node id, name, or path:a-b)');

  if (NODE_ID_RE.test(key)) {
    const node = store.nodesById.get(key);
    if (!node) {
      throw new UsageError(`no indexed symbol has id "${key}" (index may be stale; run \`scope scan --full\`)`);
    }
    return { kind: 'node', node };
  }

  const range = key.match(RANGE_RE);
  if (range) {
    if (!allowRange) {
      throw new UsageError(`"${key}" is a line range; this command needs a symbol id or name`);
    }
    const posixPath = range[1];
    let sl = Number(range[2]);
    let el = range[3] !== undefined ? Number(range[3]) : sl;
    if (!Number.isInteger(sl) || !Number.isInteger(el) || sl < 1 || el < 1) {
      throw new UsageError(`invalid line range in "${key}"; expected path:a-b with positive integers`);
    }
    if (el < sl) [sl, el] = [el, sl];
    if (!store.trackedPaths.has(posixPath)) {
      const near = [...store.trackedPaths].filter((p) => p.endsWith(posixPath)).sort();
      const hint = near.length > 0 ? ` close matches: ${near.slice(0, 3).join(', ')}` : '';
      throw new UsageError(`path "${posixPath}" is not tracked by the index.${hint}`);
    }
    return { kind: 'range', path: posixPath, sl, el };
  }

  const matches = store.byName.get(key) ?? [];
  const defs = matches.filter((n) => n.kind !== 'module');
  if (defs.length === 1) return { kind: 'node', node: defs[0] };
  if (defs.length > 1) {
    const list = defs
      .slice()
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.id < b.id ? -1 : 1))
      .map((n) => `  ${n.id} ${n.kind} ${n.path}:${n.span.sl}-${n.span.el}`)
      .join('\n');
    throw new UsageError(`"${key}" is ambiguous (${defs.length}):\n${list}\ndisambiguate with a node id`);
  }
  throw new UsageError(`no indexed symbol named "${key}" (try \`scope locate ${key}\` first)`);
}
