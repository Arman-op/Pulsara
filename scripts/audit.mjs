#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Fails the build on a new high or critical advisory in production
 * dependencies, and on nothing else.
 *
 * `npm audit` alone is a poor gate. Run with no threshold it fails on
 * everything, including advisories in build tooling that never ships and
 * transitive ones with no upstream fix, so a team turns it off within a week.
 * Run with `--audit-level=critical` it passes silently through exactly the
 * findings somebody should look at.
 *
 * The middle position is an allowlist that costs something to add to: each
 * entry has to say which path reaches the code, why it is not reachable here,
 * what the fix would cost, and when somebody will look again. An advisory that
 * nobody can justify in those terms fails the build.
 *
 * Development dependencies are excluded because they are not in the image. A
 * vulnerability in a test runner is worth knowing about, and it is not the same
 * risk as one in the code serving requests.
 */

const run = promisify(execFile);

const BLOCKING = new Set(['high', 'critical']);

const here = dirname(fileURLToPath(import.meta.url));
const allowlist = JSON.parse(readFileSync(join(here, 'audit-allowlist.json'), 'utf8')).allowed;

const allowed = new Map(allowlist.map((entry) => [entry.module, entry]));

/** `npm audit` exits non-zero when it finds anything, so the error carries the report. */
async function auditReport() {
  try {
    const { stdout } = await run('npm', ['audit', '--omit=dev', '--json'], {
      shell: process.platform === 'win32',
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.length > 0) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

const report = await auditReport();
const vulnerabilities = Object.values(report.vulnerabilities ?? {});

const blocking = [];
const excused = [];
const stale = [];

const today = new Date();

/**
 * npm reports two kinds of entry. One carries advisory objects in `via` and is
 * the package the advisory is actually against; the rest carry only strings —
 * the names of vulnerable packages they depend on — and are consequences of it.
 *
 * Only the first kind is a finding. Listing the pass-through packages too would
 * make the allowlist a transitive-closure exercise, so that allowlisting one
 * advisory meant naming every package between it and the root.
 */
function isRootAdvisory(vulnerability) {
  return vulnerability.via.some((via) => typeof via === 'object');
}

for (const vulnerability of vulnerabilities) {
  if (!BLOCKING.has(vulnerability.severity)) continue;
  if (!isRootAdvisory(vulnerability)) continue;

  const excuse = allowed.get(vulnerability.name);

  if (!excuse) {
    blocking.push(vulnerability);
    continue;
  }

  excused.push(vulnerability);

  // An allowlist without expiry is a way of never looking again.
  if (new Date(excuse.reviewBy) < today) stale.push(excuse);
}

for (const entry of excused) {
  const excuse = allowed.get(entry.name);
  console.log(`allowed  ${entry.severity.padEnd(8)} ${entry.name}  (review by ${excuse.reviewBy})`);
}

for (const entry of stale) {
  console.error(`\nThe allowlist entry for ${entry.module} was due for review on ${entry.reviewBy}.`);
}

if (blocking.length > 0) {
  console.error('\nUnreviewed high or critical advisories in production dependencies:\n');
  for (const entry of blocking) {
    const titles = entry.via
      .filter((via) => typeof via === 'object')
      .map((via) => via.title)
      .join('; ');
    console.error(`  [${entry.severity}] ${entry.name}: ${titles || 'see npm audit'}`);
  }
  console.error(
    '\nFix it, or add an entry to scripts/audit-allowlist.json saying why it is not reachable here.\n',
  );
}

const failed = blocking.length > 0 || stale.length > 0;

if (!failed) {
  console.log(
    `\nNo unreviewed high or critical advisories in production dependencies (${excused.length} allowed, ${vulnerabilities.length} total including lower severities).`,
  );
}

process.exit(failed ? 1 : 0);
