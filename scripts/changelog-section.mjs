#!/usr/bin/env node
/**
 * Extract one version's section from CHANGELOG.md.
 *
 * Used by the release workflow to build GitHub Release notes, so the notes
 * and the changelog can never drift: there is one source and it is the file
 * already under review.
 *
 * Exits non-zero when the version has no section. That is deliberate — a
 * release whose changelog entry was forgotten should fail loudly rather
 * than publish with auto-generated or empty notes.
 *
 * Usage: node scripts/changelog-section.mjs 1.0.0 [path/to/CHANGELOG.md]
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const version = process.argv[2];
if (!version) {
  console.error('usage: changelog-section.mjs <version> [changelog-path]');
  process.exit(2);
}

// Accept a leading `v` so callers can pass a tag name directly.
const wanted = version.replace(/^v/, '');
const changelogPath = process.argv[3] ?? join(repoRoot, 'CHANGELOG.md');

const lines = readFileSync(changelogPath, 'utf8').split('\n');

// Headings look like: `## [0.2.0] — 2026-08-18`. Match on the bracketed
// version only; the date separator has varied (em dash vs hyphen) and is
// not worth being strict about.
const headingFor = (v) => new RegExp(`^##\\s*\\[${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`);

const start = lines.findIndex((l) => headingFor(wanted).test(l));
if (start === -1) {
  console.error(
    `No CHANGELOG section found for version ${wanted}.\n` +
      `Add a "## [${wanted}] — <date>" heading to ${changelogPath} before tagging.`,
  );
  process.exit(1);
}

// The section runs to the next `## ` heading, or to the link-definition
// block at the bottom of the file.
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  const line = lines[i];
  if (/^##\s/.test(line) || /^\[[^\]]+\]:\s+https?:/.test(line)) {
    end = i;
    break;
  }
}

const body = lines
  .slice(start + 1, end)
  .join('\n')
  .trim();

if (body.length === 0) {
  console.error(`CHANGELOG section for ${wanted} is empty.`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
