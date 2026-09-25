import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SYMBOLS_DIRNAME,
  META_FILE,
  SCHEMA_VERSION,
  TOOL_ID,
  symbolsDirFor,
  ledgerDirFor,
  storeDirFor,
} from './store.mjs';
import { LEDGER_SCHEMA_VERSION, NOTES_FILE } from './ledger.mjs';
import { toPosix } from './util.mjs';

// The index and the `view` output are derived; the ledger is not, so it stays tracked.
export const GITIGNORE_LINES = Object.freeze(['.scope/symbols/index/', '.scope/symbols/view-data.html']);

/**
 * Initialize the .scope/symbols/ skeleton (idempotent):
 *   .scope/symbols/index/  — store dir (+ placeholder meta.json if absent)
 *   .scope/symbols/ledger/ — notes dir (+ empty notes.jsonl if absent)
 *   .gitignore             — gains `.scope/symbols/index/` and `.scope/symbols/view-data.html`;
 *                            `.scope/symbols/ledger/` stays tracked
 *
 * Never clobbers existing meta.json / notes.jsonl / .gitignore content.
 */
export async function initProject(rootAbs) {
  const indexDir = storeDirFor(rootAbs);
  const ledDir = ledgerDirFor(rootAbs);
  await mkdir(indexDir, { recursive: true });
  await mkdir(ledDir, { recursive: true });

  const notesPath = path.join(ledDir, NOTES_FILE);
  let notesCreated = false;
  try {
    await writeFile(notesPath, '', { flag: 'wx' });
    notesCreated = true;
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
  }

  const metaPath = path.join(indexDir, META_FILE);
  let metaWritten = false;
  try {
    const placeholder = {
      _: 'meta',
      schemaVersion: SCHEMA_VERSION,
      tool: TOOL_ID,
      placeholder: true,
      complete: false,
    };
    await writeFile(metaPath, `${JSON.stringify(placeholder)}\n`, { flag: 'wx' });
    metaWritten = true;
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
  }

  const gitignorePath = path.join(rootAbs, '.gitignore');
  let gitignore = null;
  try {
    gitignore = await readFile(gitignorePath, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }

  let gitignoreStatus = 'present';
  let wholesaleIgnore = false;
  if (gitignore === null) {
    await writeFile(gitignorePath, `${GITIGNORE_LINES.join('\n')}\n`);
    gitignoreStatus = 'created';
  } else {
    const lines = gitignore.split('\n').map((l) => l.trim());
    wholesaleIgnore = lines.some((l) => ['.scope', SYMBOLS_DIRNAME].includes(l.replace(/\/$/, '')));
    const missing = GITIGNORE_LINES.filter((g) => !lines.includes(g) && !lines.includes(g.replace(/\/$/, '')));
    // wholesaleIgnore means the repo ignores `.scope/symbols/` entirely -- appending the narrower
    // lines under it changes nothing except leaving .gitignore dirty after a scan.
    if (missing.length && !wholesaleIgnore) {
      let out = gitignore;
      if (out.length > 0 && !out.endsWith('\n')) out += '\n';
      out += `${missing.join('\n')}\n`;
      await writeFile(gitignorePath, out);
      gitignoreStatus = 'appended';
    }
  }

  return {
    symbolsDirPosix: toPosix(symbolsDirFor(rootAbs)),
    ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
    notesCreated,
    metaWritten,
    gitignoreStatus,
    wholesaleIgnore,
  };
}
