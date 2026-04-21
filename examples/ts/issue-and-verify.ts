/**
 * Issuer example: bootstrap → license → usage → token → verify.
 *
 * Shows the full service-layer flow without any HTTP surface. Uses
 * in-memory storage so it runs in isolation.
 *
 * Run: bun run examples/ts/issue-and-verify.ts
 */

import {
  AlgorithmRegistry,
  KeyAlgBindings,
  createAdvancingClock,
  createLicense,
  ed25519Backend,
  generateRootKey,
  issueInitialSigningKey,
  issueToken,
  registerUsage,
  verify,
  type KeyRecord,
  type SignatureBackend,
  type KeyAlg,
} from '@anorebel/licensing';
import { MemoryStorage } from '@anorebel/licensing/storage/memory';

async function main() {
  // Clock that advances deterministically — used for iat/exp and id gen.
  const clock = createAdvancingClock('2026-04-19T10:00:00.000000Z');
  const storage = new MemoryStorage({ clock });
  const backends = new Map<KeyAlg, SignatureBackend>([['ed25519', ed25519Backend]]);

  // 1. Bootstrap keys (global scope — scope_id: null).
  const root = await generateRootKey(storage, clock, backends, {
    scope_id: null,
    alg: 'ed25519',
    passphrase: 'root-pw',
  });

  const signing = await issueInitialSigningKey(storage, clock, backends, {
    scope_id: null,
    alg: 'ed25519',
    rootKid: root.kid,
    rootPassphrase: 'root-pw',
    signingPassphrase: 'sign-pw',
  });

  console.log('Bootstrapped signing key:', signing.kid);

  // 2. Create a license.
  const license = await createLicense(storage, clock, {
    scope_id: null,
    template_id: null,
    licensable_type: 'User',
    licensable_id: 'user-42',
    max_usages: 3,
    expires_at: '2027-04-19T10:00:00.000000Z',
    grace_until: '2027-05-19T10:00:00.000000Z',
  });

  console.log('License created:', license.id, 'status:', license.status);

  // 3. Register a device — activates the license, claims seat 1/3.
  const fingerprint = 'a'.repeat(64); // SHA-256 hex
  const { license: active, usage } = await registerUsage(storage, clock, {
    license_id: license.id,
    fingerprint,
  });

  console.log('Usage registered:', usage.id, 'license status:', active.status);

  // 4. Issue a LIC1 token, TTL 1 hour.
  const { token } = await issueToken(storage, clock, backends, {
    license: active,
    usage,
    ttlSeconds: 3600,
    alg: 'ed25519',
    signingPassphrase: 'sign-pw',
  });

  console.log('Token issued:', token.slice(0, 60) + '…');

  // 5. Verify independently — this is what a client does with just the
  //    public half. We read the stored key's public PEM back.
  const storedKey = await storage.getKeyByKid(signing.kid);
  if (!storedKey) throw new Error('signing key vanished');

  const registry = new AlgorithmRegistry();
  registry.register(ed25519Backend);

  const bindings = new KeyAlgBindings();
  bindings.bind(signing.kid, 'ed25519');

  const publicOnly: KeyRecord = {
    kid: storedKey.kid,
    alg: storedKey.alg,
    publicPem: storedKey.public_pem,
    privatePem: null,
    raw: { publicRaw: null as unknown as Uint8Array, privateRaw: null },
  };

  const verified = await verify(token, {
    registry,
    bindings,
    keys: new Map([[signing.kid, publicOnly]]),
    now: new Date('2026-04-19T10:30:00Z'),
  });

  console.log('Verified payload:', {
    license_id: verified.payload.license_id,
    fingerprint: verified.payload.fingerprint,
    exp: verified.payload.exp,
  });
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
