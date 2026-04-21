#!/usr/bin/env bun
/**
 * interop-canonicalize: serialize JSON values through the TypeScript
 * canonicalizer and emit the resulting bytes as base64 strings (so the Go
 * test harness can decode and compare without worrying about stdio text
 * encoding).
 *
 * Two call shapes are supported to keep per-value cost low; the property
 * test runs 10k iterations and spawning 10k bun processes would dominate
 * wallclock:
 *
 *   single-value mode:
 *     stdin:  { "value": <any JSON> }
 *     stdout: { "ok": true, "value": { "canonical_b64": "..." } }
 *
 *   batch mode:
 *     stdin:  { "values": [<any JSON>, <any JSON>, ...] }
 *     stdout: { "ok": true, "value": { "canonical_b64": ["...", "...", ...] } }
 *
 * The batch path keeps Bun startup amortized across thousands of payloads.
 */

import { canonicalize } from '@anorebel/licensing/canonical-json';

import { runCli } from '../src/io.ts';

interface SingleInput {
  value: unknown;
}
interface BatchInput {
  values: unknown[];
}

await runCli(async (raw) => {
  if (raw && typeof raw === 'object' && 'values' in raw) {
    const { values } = raw as BatchInput;
    if (!Array.isArray(values)) {
      throw new Error('canonicalize: "values" must be an array');
    }
    const out: string[] = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const bytes = canonicalize(values[i] as never);
      out[i] = Buffer.from(bytes).toString('base64');
    }
    return { canonical_b64: out };
  }

  if (!raw || typeof raw !== 'object' || !('value' in raw)) {
    throw new Error('canonicalize: missing required field (value or values)');
  }
  const { value } = raw as SingleInput;
  const bytes = canonicalize(value as never);
  return { canonical_b64: Buffer.from(bytes).toString('base64') };
});
