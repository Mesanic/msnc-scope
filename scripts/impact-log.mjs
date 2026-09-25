// Where `scope impact` records what it answered for, and where the pre-edit hook looks.
// In the repo's .scope/files/overlays/, not the OS temp dir: a sandboxed Bash has its own TMPDIR
// while the hook runs outside the sandbox, so a temp-dir log is never seen by the gate. The
// repo is the one place both can reach. overlays/ is machine state that scan keeps
// gitignored (it re-adds the rule on every scan), so the log is never committed by accident.
import fs from 'node:fs';
import path from 'node:path';

export const IMPACT_TTL_MS = (Number(process.env.SCOPE_IMPACT_TTL_MIN) || 120) * 60 * 1000;

export function impactLogPath(root) {
  return path.join(root, '.scope', 'files', 'overlays', 'impact.log');
}

// Best-effort: a read-only tree must not fail impact; the gate then keeps blocking.
// mkdir because overlays/ is gitignored, so a fresh clone with a tracked .scope/files/graph lacks it.
// Its own `*` .gitignore because impact can run before any scan adds the root rule.
// Entries past the TTL are dropped on each write, since the gate reads the whole log.
export function recordImpact(root, file) {
  try {
    const log = impactLogPath(root);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const ignore = path.join(path.dirname(log), '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    const cutoff = Date.now() - IMPACT_TTL_MS;
    let kept = [];
    try { kept = fs.readFileSync(log, 'utf8').split('\n').filter((l) => Number(l.slice(0, l.indexOf(' '))) >= cutoff); } catch { /* no log yet */ }
    // ponytail: read-then-write, so two impacts at the same instant can lose one entry (that edit is refused once)
    fs.writeFileSync(log, [...kept, `${Date.now()} ${file}`, ''].join('\n'));
  } catch { /* gate falls back to blocking */ }
}
