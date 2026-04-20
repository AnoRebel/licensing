/**
 * Crypto subsystem barrel.
 *
 * Re-exports:
 *   - Backend-agnostic types & registry (`./types.ts`)
 *   - All three bundled backends (ed25519, rsa-pss, hmac) as named exports
 *
 * Consumers who only need one alg should import the narrower subpath entry
 * (`@licensing/sdk/crypto/ed25519` etc.) so the other backends stay out of
 * their bundle — ESM tree-shaking already does this via named imports, but
 * the subpath form is clearer intent.
 */

export { ED25519_RAW_KEY_LEN, ED25519_SIG_LEN, ed25519Backend } from './ed25519.ts';
export {
  HMAC_DEFAULT_SECRET_LEN,
  HMAC_HASH,
  HMAC_MIN_SECRET_LEN,
  HMAC_SIG_LEN,
  hmacBackend,
} from './hmac.ts';
export {
  RSA_DEFAULT_BITS,
  RSA_MIN_BITS,
  RSA_PSS_HASH,
  RSA_PSS_SALT_LEN,
  rsaPssBackend,
} from './rsa.ts';
export * from './types.ts';
