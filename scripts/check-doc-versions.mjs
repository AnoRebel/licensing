#!/usr/bin/env node
/**
 * Fail when a shipped doc makes a version claim that no longer matches
 * VERSION.
 *
 * This exists because the 0.2.0 release shipped with the README still
 * announcing "pre-release, tracking v0.1.0, not yet production-ready" —
 * nothing checked, so nobody noticed.
 *
 * What counts as a claim, and what does not:
 *
 *   - A version inside a fenced code block is an EXAMPLE. Release
 *     procedures legitimately walk through `v0.1.0-rc.1` as an
 *     illustration, and rewriting those on every bump would be churn with
 *     no reader benefit.
 *   - A version inside inline backticks is likewise an example: semver
 *     tables read `0.1.0 → 0.2.0` to show the SHAPE of a bump, not to
 *     claim either is current.
 *   - A version in bare prose is a CLAIM about the current state, and a
 *     stale one misinforms. That is the only case this fails on.
 *   - A line carrying `<!-- doc-version: historical -->` is exempt.
 *     Changelog-style prose about what a past release did is not stale
 *     just because time passed.
 *
 * Usage: node scripts/check-doc-versions.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = readFileSync(join(repoRoot, 'VERSION'), 'utf8').trim();

/** Docs a consumer reads. CHANGELOG is excluded: it is a historical record
 *  by definition, and every past version in it is correct. */
const DOCS = [
  'README.md',
  'RELEASING.md',
  'docs/versioning.md',
  'docs/token-format.md',
  'docs/security.md',
  'docs/threat-model.md',
  'docs/events.md',
  'docs/templates.md',
  'docs/trials.md',
  'docs/framework-integrations.md',
  'examples/ts/README.md',
  'examples/go/README.md',
  'admin/README.md',
];

// Matches a semver-ish version reference: v0.1.0, 0.1.0-rc.1, etc.
const VERSION_REF = /\bv?(\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?)\b/g;

const problems = [];

for (const rel of DOCS) {
  let text;
  try {
    text = readFileSync(join(repoRoot, rel), 'utf8');
  } catch {
    continue; // Doc does not exist in this tree; not this check's business.
  }

  const lines = text.split('\n');
  let inFence = false;

  for (const [i, line] of lines.entries()) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.includes('doc-version: historical')) continue;
    // Headings are document structure. A numbered section like "4.3.1" is
    // shaped exactly like a semver, and a heading naming a future version
    // ("Stability policy from 1.0.0 onward") is a forward reference rather
    // than a claim about what shipped.
    if (/^\s*#{1,6}\s/.test(line)) continue;

    // Strip inline-code spans before scanning: `0.1.0 → 0.2.0` in a semver
    // table illustrates a bump shape rather than asserting a current
    // version.
    const prose = line.replace(/`[^`]*`/g, '');

    for (const match of prose.matchAll(VERSION_REF)) {
      const found = match[1];
      if (found === version) continue;
      problems.push({
        file: relative(repoRoot, join(repoRoot, rel)),
        line: i + 1,
        found,
        text: line.trim(),
      });
    }
  }
}

if (problems.length > 0) {
  console.error(`Stale version references (VERSION is ${version}):\n`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}  refers to ${p.found}`);
    console.error(`    ${p.text.slice(0, 100)}`);
  }
  console.error(
    `\nEither update the reference, move it into a code fence if it is an\n` +
      `illustrative example, or mark the line with an HTML comment\n` +
      `containing "doc-version: historical" if it describes a past release.`,
  );
  process.exit(1);
}

console.log(`No stale version references. VERSION=${version}`);
