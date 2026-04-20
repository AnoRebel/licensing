/**
 * Base64url (RFC 4648 §5) encode / decode, **without** `=` padding.
 *
 * Runtime-native: relies on Bun's / Node's built-in `Buffer` where available
 * and falls back to a hand-rolled conversion for pure-web contexts. The
 * output of `encode` NEVER contains `=`; the input of `decode` MUST NOT
 * contain `=`.
 */

import { errors } from './errors.ts';

const BUF: typeof globalThis.Buffer | undefined =
  typeof globalThis.Buffer === 'function' ? globalThis.Buffer : undefined;

export function encode(bytes: Uint8Array): string {
  let b64: string;
  if (BUF) {
    b64 = BUF.from(bytes).toString('base64');
  } else {
    // Fallback for web: encode via binary string.
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
    b64 = globalThis.btoa(bin);
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decode(s: string): Uint8Array {
  if (s.includes('=')) {
    throw errors.tokenMalformed('base64url segment contains padding');
  }
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw errors.tokenMalformed('base64url segment contains invalid characters');
  }
  // Re-pad for the underlying decoder.
  const padLen = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  if (BUF) {
    return new Uint8Array(BUF.from(b64, 'base64'));
  }
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
