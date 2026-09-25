// git-overlay: per-file push state, written to .scope/files/overlays/git.json (gitignored).
import path from 'node:path';
import { filesDir, fail, run, writeFileAtomic } from './store.mjs';

// Worst state wins, so a file that is both committed-unpushed and edited reads as "modified".
const RANK = { pushed: 0, unpushed: 1, staged: 2, modified: 3, untracked: 4, conflicted: 5 };

function worse(a, b) {
  if (!a) return b;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

function parsePorcelain(z) {
  const files = new Map();
  const parts = z.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    // Renames and copies carry a second NUL-separated path (the old name); skip it.
    if (x === 'R' || x === 'C') i += 1;
    // Porcelain collapses a wholly-untracked directory to "dir/". Graph nodes are files, so a
    // directory entry can never match one - drop it rather than carry a phantom key.
    if (file.endsWith('/')) continue;
    let state;
    if (x === '?' && y === '?') state = 'untracked';
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) state = 'conflicted';
    else if (y !== ' ' && y !== '') state = 'modified';
    else if (x !== ' ' && x !== '') state = 'staged';
    if (state) files.set(file, worse(files.get(file), state));
  }
  return files;
}

export function gitOverlay(ctx) {
  const { root } = ctx;
  const dir = filesDir(root);
  if (!run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root }).ok) {
    fail('not a git repository — push state is unavailable here');
  }

  const branchRes = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  const branch = branchRes.ok ? branchRes.out.trim() : null;
  const detached = branch === 'HEAD';
  const hasCommits = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).ok;

  const upRes = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: root });
  const upstream = upRes.ok ? upRes.out.trim() : null;

  const status = run('git', ['status', '--porcelain=v1', '-z'], { cwd: root });
  const files = status.ok ? parsePorcelain(status.out) : new Map();

  let ahead = 0;
  let behind = 0;
  const notes = [];

  if (upstream && hasCommits) {
    // Three-dot: compare against the merge base, so files changed only upstream are not
    // misreported as local work when the branch is behind.
    const diff = run('git', ['diff', '--name-only', '-z', `${upstream}...HEAD`], { cwd: root });
    if (diff.ok) {
      for (const f of diff.out.split('\0').filter(Boolean)) {
        files.set(f, worse(files.get(f), 'unpushed'));
      }
    }
    const counts = run('git', ['rev-list', '--left-right', '--count', `${upstream}...HEAD`], { cwd: root });
    if (counts.ok) {
      const [b, a] = counts.out.trim().split(/\s+/).map(Number);
      behind = b || 0;
      ahead = a || 0;
    }
  } else if (hasCommits) {
    // No tracking branch: push state is unknowable, and a badge on every file says nothing. Only
    // working-tree changes are marked; committed files render plain, and the note carries the caveat.
    notes.push('no upstream branch — push state unknown, only working-tree changes are marked');
  } else {
    notes.push('no commits yet — nothing can be pushed');
  }

  const counts = { pushed: 0, unpushed: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0 };
  const listed = {};
  for (const [f, s] of [...files.entries()].sort()) {
    if (s === 'pushed') continue;
    listed[f] = s;
    counts[s] += 1;
  }
  const totalRes = run('git', ['ls-files', '-z'], { cwd: root });
  const totalTracked = totalRes.ok ? totalRes.out.split('\0').filter(Boolean).length : 0;
  counts.pushed = Math.max(0, totalTracked - Object.keys(listed).filter((f) => listed[f] !== 'untracked').length);

  const overlay = {
    v: 1,
    generated: new Date().toISOString(),
    branch: detached ? null : branch,
    detached,
    upstream,
    ahead,
    behind,
    files: listed,
    default: 'pushed',
    counts,
    notes,
  };
  writeFileAtomic(path.join(dir, 'overlays', 'git.json'), JSON.stringify(overlay, null, 1) + '\n');
  return overlay;
}
