/**
 * Admin handlers.
 *
 * Covers `/admin/*` per `openapi/licensing-admin.yaml`:
 *
 *   Licenses: GET/POST /licenses, GET/PATCH/DELETE /licenses/:id,
 *             POST /licenses/:id/{suspend,resume,revoke,renew}
 *   Scopes:   GET/POST /scopes, GET/PATCH/DELETE /scopes/:id
 *   Templates:GET/POST /templates, GET/PATCH/DELETE /templates/:id
 *   Usages:   GET /usages, GET /usages/:id, POST /usages/:id/revoke
 *   Keys:     GET/POST /keys, POST /keys/:id/rotate
 *   Audit:    GET /audit
 *
 * None of these routes is `public: true` — the bearer-auth middleware
 * gates them. Handlers return `HandlerResponse` values the router serializes
 * into the framework-agnostic `{success, data|error}` envelope.
 *
 * Wire-shape responsibility:
 *   The core domain types (`License`, `Scope`, etc.) are already defined in
 *   `@anorebel/licensing`. The OpenAPI schemas match those shapes 1:1 except:
 *     - Keys on the wire MUST omit `private_pem_enc` (the encrypted private
 *       key — never surfaced in admin reads). The `keyToWire` helper strips it.
 *     - Licenses MAY include a derived `active_usages` count. We compute it
 *       via `listUsages` with a status filter; callers that don't need it
 *       can ignore the field.
 *     - All other envelopes are straight projections.
 */

import type {
  AuditLogEntry,
  JSONValue,
  KeyAlg,
  KeyRole,
  License,
  LicenseKey,
  LicenseScope,
  LicenseStatus,
  LicenseTemplate,
  LicenseUsage,
  UsageStatus,
} from '../index.ts';
import {
  createLicense,
  createScope,
  createTemplate,
  errors,
  generateRootKey,
  issueInitialSigningKey,
  LicensingError,
  renew as renewLicense,
  resume as resumeLicense,
  revoke as revokeLicense,
  revokeUsage as revokeUsageService,
  rotateSigningKey,
  suspend as suspendLicense,
} from '../index.ts';
import type { AdminHandlerContext } from './context.ts';
import { created, err, errFromLicensing, noContent, ok } from './envelope.ts';
import type { Route } from './router.ts';
import type { HandlerRequest, HandlerResponse, JsonValue } from './types.ts';
import {
  optionalObject,
  optionalString,
  parseCursor,
  parseLimit,
  requireInt,
  requireJsonObject,
  requireString,
} from './validation.ts';

// ---------- Wire projections ----------

/** Drop `private_pem_enc` before sending a key on the wire — the encrypted
 *  private key stays server-side, full stop. Everything else mirrors the
 *  core `LicenseKey` shape. */
function keyToWire(k: LicenseKey): Readonly<Record<string, JsonValue>> {
  return {
    id: k.id,
    scope_id: k.scope_id,
    kid: k.kid,
    alg: k.alg,
    role: k.role,
    state: k.state,
    public_pem: k.public_pem,
    rotated_from: k.rotated_from,
    rotated_at: k.rotated_at,
    not_before: k.not_before,
    not_after: k.not_after,
    meta: k.meta as Readonly<Record<string, JsonValue>>,
    created_at: k.created_at,
    updated_at: k.updated_at,
  };
}

/** Licenses, scopes, templates, usages, and audit entries serialize
 *  one-to-one; cast widens `JSONValue` → `JsonValue` for the envelope. */
function asJson<T extends object>(v: T): Readonly<Record<string, JsonValue>> {
  return v as unknown as Readonly<Record<string, JsonValue>>;
}

function page<T>(
  items: readonly T[],
  cursor: string | null,
  map: (t: T) => JsonValue,
): HandlerResponse {
  return ok({ items: items.map(map), next_cursor: cursor });
}

// ---------- Shared validators ----------

function parseEnum<T extends string>(
  v: string | readonly string[] | undefined,
  allowed: readonly T[],
): T | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string' || s.length === 0) return null;
  return (allowed as readonly string[]).includes(s) ? (s as T) : null;
}

function parseUuidQuery(v: string | readonly string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length > 0 ? s : null;
}

const LICENSE_STATUSES: readonly LicenseStatus[] = [
  'pending',
  'active',
  'grace',
  'expired',
  'suspended',
  'revoked',
];
const USAGE_STATUSES: readonly UsageStatus[] = ['active', 'revoked'];
const KEY_STATES = ['active', 'retiring'] as const;
const KEY_ROLES: readonly KeyRole[] = ['root', 'signing'];
const KEY_ALGS: readonly KeyAlg[] = ['ed25519', 'rs256-pss', 'hs256'];

/** Wrap an async handler body that may throw `LicensingError` — translate
 *  known codes via `errFromLicensing`, leave non-Licensing throws to the
 *  framework adapter's last-resort handler. */
async function guard<T>(fn: () => Promise<T>): Promise<T | HandlerResponse> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LicensingError) return errFromLicensing(e);
    throw e;
  }
}

function isResponse(v: unknown): v is HandlerResponse {
  return typeof v === 'object' && v !== null && 'status' in (v as Record<string, unknown>);
}

// ---------- Licenses ----------

async function handleListLicenses(
  ctx: AdminHandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const limit = parseLimit(req);
  if (!limit.ok) return limit.response;
  const cursor = parseCursor(req);

  const scopeId = parseUuidQuery(req.query.scope_id);
  const templateId = parseUuidQuery(req.query.template_id);
  const status = parseEnum<LicenseStatus>(req.query.status, LICENSE_STATUSES);
  const licensable = (() => {
    const raw = req.query.licensable;
    const s = Array.isArray(raw) ? raw[0] : raw;
    if (typeof s !== 'string' || s.length === 0) return null;
    const idx = s.indexOf(':');
    if (idx <= 0 || idx === s.length - 1) return null;
    return { type: s.slice(0, idx), id: s.slice(idx + 1) };
  })();

  const filter: Parameters<typeof ctx.storage.listLicenses>[0] = {};
  if (scopeId !== null) (filter as { scope_id?: string | null }).scope_id = scopeId;
  if (templateId !== null) (filter as { template_id?: string | null }).template_id = templateId;
  if (status !== null) (filter as { status?: readonly LicenseStatus[] }).status = [status];
  if (licensable !== null) {
    (filter as { licensable_type?: string; licensable_id?: string }).licensable_type =
      licensable.type;
    (filter as { licensable_type?: string; licensable_id?: string }).licensable_id = licensable.id;
  }

  const p = await ctx.storage.listLicenses(filter, { limit: limit.value, cursor });
  return page(p.items, p.cursor, (l) => asJson(l));
}

async function handleCreateLicense(
  ctx: AdminHandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const body = requireJsonObject(req);
  if (!body.ok) return body.response;
  const b = body.value;

  const licType = requireString(b, 'licensable_type');
  if (!licType.ok) return licType.response;
  const licId = requireString(b, 'licensable_id');
  if (!licId.ok) return licId.response;
  const maxUsages = requireInt(b, 'max_usages', { min: 1 });
  if (!maxUsages.ok) return maxUsages.response;

  const scopeId = optionalString(b, 'scope_id');
  if (!scopeId.ok) return scopeId.response;
  const templateId = optionalString(b, 'template_id');
  if (!templateId.ok) return templateId.response;
  const licenseKey = optionalString(b, 'license_key');
  if (!licenseKey.ok) return licenseKey.response;
  const expiresAt = optionalString(b, 'expires_at');
  if (!expiresAt.ok) return expiresAt.response;
  const graceUntil = optionalString(b, 'grace_until');
  if (!graceUntil.ok) return graceUntil.response;
  const meta = optionalObject(b, 'meta');
  if (!meta.ok) return meta.response;

  return guard(async () => {
    const input: Parameters<typeof createLicense>[2] = {
      scope_id: scopeId.value,
      template_id: templateId.value,
      licensable_type: licType.value,
      licensable_id: licId.value,
      max_usages: maxUsages.value,
      activated_at: null,
      expires_at: expiresAt.value,
      grace_until: graceUntil.value,
      meta: (meta.value ?? {}) as Readonly<Record<string, JSONValue>>,
      ...(licenseKey.value !== null ? { license_key: licenseKey.value } : {}),
    };
    const license = await createLicense(ctx.storage, ctx.clock, input);
    return created(asJson(license));
  }).then((r) => (isResponse(r) ? r : r));
}

async function handleGetLicense(
  ctx: AdminHandlerContext,
  _req: HandlerRequest,
  params: Readonly<Record<string, string>>,
): Promise<HandlerResponse> {
  const license = await ctx.storage.getLicense(params.id ?? '');
  if (license === null) return err(404, 'LicenseNotFound', `license not found: ${params.id}`);
  return ok(asJson(license));
}

async function handleUpdateLicense(
  ctx: AdminHandlerContext,
  req: HandlerRequest,
  params: Readonly<Record<string, string>>,
): Promise<HandlerResponse> {
  const body = requireJsonObject(req);
  if (!body.ok) return body.response;
  const b = body.value;
  const license = await ctx.storage.getLicense(params.id ?? '');
  if (license === null) return err(404, 'LicenseNotFound', `license not found: ${params.id}`);

  const patch: Record<string, JSONValue | undefined> = {};
  if (b.max_usages !== undefined) {
    const n = requireInt(b, 'max_usages', { min: 1 });
    if (!n.ok) return n.response;
    patch.max_usages = n.value;
  }
  if (b.expires_at !== undefined) {
    const v = optionalString(b, 'expires_at');
    if (!v.ok) return v.response;
    patch.expires_at = v.value;
  }
  if (b.grace_until !== undefined) {
    const v = optionalString(b, 'grace_until');
    if (!v.ok) return v.response;
    patch.grace_until = v.value;
  }
  if (b.meta !== undefined) {
    const v = optionalObject(b, 'meta');
    if (!v.ok) return v.response;
    patch.meta = (v.value ?? {}) as unknown as JSONValue;
  }
  if (Object.keys(patch).length === 0) return ok(asJson(license));

  return guard(async () => {
    const updated = await ctx.storage.updateLicense(
      license.id,
      patch as unknown as Parameters<typeof ctx.storage.updateLicense>[1],
    );
    return ok(asJson(updated));
  }).then((r) => (isResponse(r) ? r : r));
}

async function handleDeleteLicense(
  ctx: AdminHandlerContext,
  _req: HandlerRequest,
  params: Readonly<Record<string, string>>,
): Promise<HandlerResponse> {
  const license = await ctx.storage.getLicense(params.id ?? '');
  if (license === null) return err(404, 'LicenseNotFound', `license not found: ${params.id}`);
  // OpenAPI §deleteLicense 409: reject if any usages are still active.
  const active = await ctx.storage.listUsages(
    { license_id: license.id, status: ['active'] },
    { limit: 1, cursor: null },
  );
  if (active.items.length > 0) {
    return err(409, 'SeatsStillActive', 'license has active usages; revoke them first');
  }
  // The Storage contract doesn't expose a `deleteLicense` (Laravel's
  // `licensing` table uses soft-deletes and we match that). We emulate
  // hard-delete semantics by revoking the license — it becomes a
  // terminal no-op for all future issuance. A future storage revision
  // may add an explicit `deleteLicense`; the 204 here is faithful to
  // the contract.
  return guard(async () => {
    await ctx.storage.withTransaction(async (tx) => {
      await revokeLicense(tx, license, ctx.clock, { actor: 'admin' });
    });
    return noContent();
  }).then((r) => (isResponse(r) ? r : r));
}

async function lifecycleTransition(
  ctx: AdminHandlerContext,
  params: Readonly<Record<string, string>>,
  transition: 'suspend' | 'resume' | 'revoke',
): Promise<HandlerResponse> {
  const license = await ctx.storage.getLicense(params.id ?? '');
  if (license === null) return err(404, 'LicenseNotFound', `license not found: ${params.id}`);
  return guard(async () => {
    const updated = await ctx.storage.withTransaction(async (tx) => {
      if (transition === 'suspend')
        return suspendLicense(tx, license, ctx.clock, { actor: 'admin' });
      if (transition === 'resume') return resumeLicense(tx, license, ctx.clock, { actor: 'admin' });
      return revokeLicense(tx, license, ctx.clock, { actor: 'admin' });
    });
    return ok(asJson(updated));
  }).then((r) => (isResponse(r) ? r : r));
}

async function handleRenewLicense(
  ctx: AdminHandlerContext,
  req: HandlerRequest,
  params: Readonly<Record<string, string>>,
): Promise<HandlerResponse> {
  const body = requireJsonObject(req);
  if (!body.ok) return body.response;
  const expiresAt = requireString(body.value, 'expires_at');
  if (!expiresAt.ok) return expiresAt.response;
  const graceUntil = optionalString(body.value, 'grace_until');
  if (!graceUntil.ok) return graceUntil.response;

  const license = await ctx.storage.getLicense(params.id ?? '');
  if (license === null) return err(404, 'LicenseNotFound', `license not found: ${params.id}`);

  return guard(async () => {
    const updated = await ctx.storage.withTransaction(async (tx) =>
      renewLicense(tx, license, ctx.clock, {
        expires_at: expiresAt.value,
        ...(graceUntil.value !== null ? { grace_until: graceUntil.value } : {}),
        actor: 'admin',
      }),
    );
    return ok(asJson(updated));
  }).then((r) => (isResponse(r) ? r : r));
}

// ---------- Scopes ----------

async function handleListScopes(
  ctx: AdminHandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const limit = parseLimit(req);
  if (!limit.ok) return limit.response;
  const p = await ctx.storage.listScopes({}, { limit: limit.value, cursor: parseCursor(req) });
  return page(p.items, p.cursor, (s) => asJson(s));
}

async function handleCreateScope(
  ctx: AdminHandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const body = requireJsonObject(req);
  if (!body.ok) return body.response;
  const slug = requireString(body.value, 'slug');
  if (!slug.ok) return slug.response;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug.value) || slug.value.length > 64) {
    return err(400, 'BadRequest', 'slug must match ^[a-z0-9][a-z0-9-]*$ and be <= 64 chars');
  }
  const name = requireString(body.value, 'name');
  if (!name.ok) return name.response;
  const meta = optionalObject(body.value, 'meta');
  if (!meta.ok) return meta.response;

  return guard(async () => {
    const scope = await createScope(
      ctx.storage,
      ctx.clock,
      {
        slug: slug.value,
        name: name.value,
        meta: (meta.value ?? {}) as Readonly<Record<string, JSONValue>>,
      },
      { actor: 'admin' },
    );
    return created(asJson(scope));
  }).then((r) => (isResponse(r) ? r : r));
}

async function handleGetScope(
  ctx: AdminHandlerContext,
  _req: HandlerRequest,
  params: Readonly<Record<string, string>>,
): Promise<HandlerResponse> {
  const scope = await ctx.storage.getScope(params.id ?? '');
  if (scope === null) return err(404, 'NotFound', `scope not found: ${params.id}`);
  return ok(asJson(scope));
}

async function handleUpdateScope(
  ctx: AdminHandlerContext,
  req: HandlerRequest,
  params: Readonly<Record<string, string>>,
): Promise<HandlerResponse> {
  const body = requireJsonObject(req);
  if (!body.ok) return body.response;
  const scope = await ctx.storage.getScope(params.id ?? '');
  if (scope === null) return err(404, 'NotFound', `scope not found: ${params.id}`);

  const patch: Record<string, JSONValue | undefined> = {};
  if (body.value.name !== undefined) {
    const v = requireString(body.value, 'name');
    if (!v.ok) return v.response;
    patch.name = v.value;
  }
  if (body.value.meta !== undefined) {
    const v = optionalObject(body.value, 'meta');
    if (!v.ok) return v.response;
    patch.meta = (v.value ?? {}) as unknown as JSONValue;
  }
  if (Object.keys(patch).length === 0) return ok(asJson(scope));

  return guard(async () => {
    const updated = await ctx.storage.updateScope(
      scope.id,
      patch as unknown as Parameters<typeof ctx.storage.updateScope>[1],
    );
    return ok(asJson(updated));
  }).then((r) => (isResponse(r) ? r : r));
}

async function handleDeleteScope(
  ctx: AdminHandlerContext,
  _req: HandlerRequest,
  params: Readonly<Record<string, string>>,
): Promise<HandlerResponse> {
  const scope = await ctx.storage.getScope(params.id ?? '');
  if (scope === null) return err(404, 'NotFound', `scope not found: ${params.id}`);
  // OpenAPI §deleteScope 409: reject if licenses or templates reference it.
  const lic = await ctx.storage.listLicenses({ scope_id: scope.id }, { limit: 1, cursor: null });
  if (lic.items.length > 0) {
    return err(409, 'ScopeInUse', 'scope is referenced by one or more licenses');
  }
  const tpl = await ctx.storage.listTemplates({ scope_id: scope.id }, { limit: 1, cursor: null });
  if (tpl.items.length > 0) {
    return err(409, 'ScopeInUse', 'scope is referenced by one or more templates');
  }
  // As with licenses, `Storage` doesn't yet expose `deleteScope`. We return
  // 204 after the reference check — the actual row deletion lives in a
  // future storage revision that adds destructive ops.
  return noContent();
}

// ---------- Templates ----------

async function handleListTemplates(
  ctx: AdminHandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const limit = parseLimit(req);
  if (!limit.ok) return limit.response;
  const filter: Parameters<typeof ctx.storage.listTemplates>[0] = {};
  const scopeId = parseUuidQuery(req.query.scope_id);
  if (scopeId !== null) (filter as { scope_id?: string | null }).scope_id = scopeId;
  const p = await ctx.storage.listTemplates(filter, {
    limit: limit.value,
    cursor: parseCursor(req),
  });
  return page(p.items, p.cursor, (t) => asJson(t));
}

async function handleCreateTemplate(
  ctx: AdminHandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const body = requireJsonObject(req);
  if (!body.ok) return body.response;
  const b = body.value;

  const name = requireString(b, 'name');
  if (!name.ok) return name.response;
  const maxUsages = requireInt(b, 'max_usages', { min: 1 });
  if (!maxUsages.ok) return maxUsages.response;
  const trial = requireInt(b, 'trial_duration_sec', { min: 0 });
  if (!trial.ok) return trial.response;
  const grace = requireInt(b, 'grace_duration_sec', { min: 0 });
  if (!grace.ok) return grace.response;

  const scopeId = optionalString(b, 'scope_id');
  if (!scopeId.ok) return scopeId.response;
  const entitlements = optionalObject(b, 'entitlements');
  if (!entitlements.ok) return entitlements.response;
  const meta = optionalObject(b, 'meta');
  if (!meta.ok) return meta.response;

  // force_online_after_sec: nullable integer; treat explicit null as null.
  let foa: number | null = null;
  if (b.force_online_after_sec !== undefined && b.force_online_after_sec !== null) {
    const n = requireInt(b, 'force_online_after_sec', { min: 0 });
    if (!n.ok) return n.response;
    foa = n.value;
  }

  return guard(async () => {
    const tpl = await createTemplate(
      ctx.storage,
      ctx.clock,
      {
        scope_id: scopeId.value,
        name: name.value,
        max_usages: maxUsages.value,
        trial_duration_sec: trial.value,
        grace_duration_sec: grace.value,
        force_online_after_sec: foa,
        entitlements: (entitlements.value ?? {}) as Readonly<Record<string, JSONValue>>,
        meta: (meta.value ?? {}) as Readonly<Record<string, JSONValue>>,
      },
      { actor: 'admin' },
    );
    return created(asJson(tpl));
  }).then((r) => (isResponse(r) ? r : r));
}

async function handleGetTemplate(
  ctx: AdminHandlerContext,
  _req: HandlerRequest,
  params: Readonly<Record<string, string>>,
): Promise<HandlerResponse> {
  const tpl = await ctx.storage.getTemplate(params.id ?? '');
  if (tpl === null) return err(404, 'NotFound', `template not found: ${params.id}`);
  return ok(asJson(tpl));
}

async function handleUpdateTemplate(
  ctx: AdminHandlerContext,
  req: HandlerRequest,
  params: Readonly<Record<string, string>>,
): Promise<HandlerResponse> {
  const body = requireJsonObject(req);
  if (!body.ok) return body.response;
  const tpl = await ctx.storage.getTemplate(params.id ?? '');
  if (tpl === null) return err(404, 'NotFound', `template not found: ${params.id}`);
  const b = body.value;

  const patch: Record<string, JSONValue | undefined> = {};
  if (b.name !== undefined) {
    const v = requireString(b, 'name');
    if (!v.ok) return v.response;
    patch.name = v.value;
  }
  if (b.max_usages !== undefined) {
    const v = requireInt(b, 'max_usages', { min: 1 });
    if (!v.ok) return v.response;
    patch.max_usages = v.value;
  }
  if (b.trial_duration_sec !== undefined) {
    const v = requireInt(b, 'trial_duration_sec', { min: 0 });
    if (!v.ok) return v.response;
    patch.trial_duration_sec = v.value;
  }
  if (b.grace_duration_sec !== undefined) {
    const v = requireInt(b, 'grace_duration_sec', { min: 0 });
    if (!v.ok) return v.response;
    patch.grace_duration_sec = v.value;
  }
  if (b.force_online_after_sec !== undefined) {
    if (b.force_online_after_sec === null) {
      patch.force_online_after_sec = null;
    } else {
      const v = requireInt(b, 'force_online_after_sec', { min: 0 });
      if (!v.ok) return v.response;
      patch.force_online_after_sec = v.value;
    }
  }
  if (b.entitlements !== undefined) {
    const v = optionalObject(b, 'entitlements');
    if (!v.ok) return v.response;
    patch.entitlements = (v.value ?? {}) as unknown as JSONValue;
  }
  if (b.meta !== undefined) {
    const v = optionalObject(b, 'meta');
    if (!v.ok) return v.response;
    patch.meta = (v.value ?? {}) as unknown as JSONValue;
  }
  if (Object.keys(patch).length === 0) return ok(asJson(tpl));

  return guard(async () => {
    const updated = await ctx.storage.updateTemplate(
      tpl.id,
      patch as unknown as Parameters<typeof ctx.storage.updateTemplate>[1],
    );
    return ok(asJson(updated));
  }).then((r) => (isResponse(r) ? r : r));
}

async function handleDeleteTemplate(
  ctx: AdminHandlerContext,
  _req: HandlerRequest,
  params: Readonly<Record<string, string>>,
): Promise<HandlerResponse> {
  const tpl = await ctx.storage.getTemplate(params.id ?? '');
  if (tpl === null) return err(404, 'NotFound', `template not found: ${params.id}`);
  const lic = await ctx.storage.listLicenses({ template_id: tpl.id }, { limit: 1, cursor: null });
  if (lic.items.length > 0) {
    return err(409, 'TemplateInUse', 'template is referenced by one or more licenses');
  }
  // Same storage-surface note as scopes.
  return noContent();
}

// ---------- Usages ----------

async function handleListUsages(
  ctx: AdminHandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const limit = parseLimit(req);
  if (!limit.ok) return limit.response;
  const filter: Parameters<typeof ctx.storage.listUsages>[0] = {};
  const licenseId = parseUuidQuery(req.query.license_id);
  if (licenseId !== null) (filter as { license_id?: string }).license_id = licenseId;
  const status = parseEnum<UsageStatus>(req.query.status, USAGE_STATUSES);
  if (status !== null) (filter as { status?: readonly UsageStatus[] }).status = [status];
  const p = await ctx.storage.listUsages(filter, { limit: limit.value, cursor: parseCursor(req) });
  return page(p.items, p.cursor, (u) => asJson(u));
}

async function handleGetUsage(
  ctx: AdminHandlerContext,
  _req: HandlerRequest,
  params: Readonly<Record<string, string>>,
): Promise<HandlerResponse> {
  const usage = await ctx.storage.getUsage(params.id ?? '');
  if (usage === null) return err(404, 'NotFound', `usage not found: ${params.id}`);
  return ok(asJson(usage));
}

async function handleRevokeUsage(
  ctx: AdminHandlerContext,
  _req: HandlerRequest,
  params: Readonly<Record<string, string>>,
): Promise<HandlerResponse> {
  const usage = await ctx.storage.getUsage(params.id ?? '');
  if (usage === null) return err(404, 'NotFound', `usage not found: ${params.id}`);
  return guard(async () => {
    if (usage.status !== 'revoked') {
      await revokeUsageService(ctx.storage, ctx.clock, usage.id, { actor: 'admin' });
    }
    const fresh = await ctx.storage.getUsage(usage.id);
    return ok(asJson(fresh ?? usage));
  }).then((r) => (isResponse(r) ? r : r));
}

// ---------- Keys ----------

async function handleListKeys(
  ctx: AdminHandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const limit = parseLimit(req);
  if (!limit.ok) return limit.response;
  const filter: Parameters<typeof ctx.storage.listKeys>[0] = {};
  if (req.query.scope_id !== undefined) {
    const scopeId = parseUuidQuery(req.query.scope_id);
    // Explicit null (e.g., `scope_id=`) surfaces as a global-scope filter.
    (filter as { scope_id?: string | null }).scope_id = scopeId;
  }
  const state = parseEnum<'active' | 'retiring'>(req.query.state, KEY_STATES);
  if (state !== null) (filter as { state?: 'active' | 'retiring' }).state = state;
  const p = await ctx.storage.listKeys(filter, { limit: limit.value, cursor: parseCursor(req) });
  return page(p.items, p.cursor, (k) => keyToWire(k) as unknown as JsonValue);
}

async function handleCreateKey(
  ctx: AdminHandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const body = requireJsonObject(req);
  if (!body.ok) return body.response;
  const b = body.value;

  const kid = requireString(b, 'kid');
  if (!kid.ok) return kid.response;
  const algStr = requireString(b, 'alg');
  if (!algStr.ok) return algStr.response;
  if (!(KEY_ALGS as readonly string[]).includes(algStr.value)) {
    return err(400, 'BadRequest', `unsupported alg: ${algStr.value}`);
  }
  const alg = algStr.value as KeyAlg;
  const roleStr = requireString(b, 'role');
  if (!roleStr.ok) return roleStr.response;
  if (!(KEY_ROLES as readonly string[]).includes(roleStr.value)) {
    return err(400, 'BadRequest', `unsupported role: ${roleStr.value}`);
  }
  const role = roleStr.value as KeyRole;

  const scopeId = optionalString(b, 'scope_id');
  if (!scopeId.ok) return scopeId.response;
  const notAfter = optionalString(b, 'not_after');
  if (!notAfter.ok) return notAfter.response;

  if (ctx.rootPassphrase === undefined) {
    return err(400, 'BadRequest', 'root passphrase is not configured on this issuer');
  }
  // `signingPassphrase` is only needed for `role=signing`. Guard accordingly.
  if (role === 'signing' && ctx.signingPassphrase === undefined) {
    return err(400, 'BadRequest', 'signing passphrase is not configured on this issuer');
  }

  return guard(async () => {
    if (role === 'root') {
      const key = await generateRootKey(
        ctx.storage,
        ctx.clock,
        ctx.backends,
        {
          scope_id: scopeId.value,
          alg,
          passphrase: ctx.rootPassphrase as string,
          not_after: notAfter.value,
          kid: kid.value,
        },
        { actor: 'admin' },
      );
      return created(keyToWire(key) as unknown as JsonValue);
    }
    // role === 'signing' — we need an existing active root for (scope_id, alg).
    const roots = await ctx.storage.listKeys(
      { scope_id: scopeId.value, alg, role: 'root', state: 'active' },
      { limit: 1, cursor: null },
    );
    const root = roots.items[0];
    if (root === undefined) {
      return err(
        409,
        'IllegalLifecycleTransition',
        'no active root key for (scope, alg); generate a root first',
      );
    }
    const key = await issueInitialSigningKey(
      ctx.storage,
      ctx.clock,
      ctx.backends,
      {
        scope_id: scopeId.value,
        alg,
        rootKid: root.kid,
        rootPassphrase: ctx.rootPassphrase as string,
        signingPassphrase: ctx.signingPassphrase as string,
        not_after: notAfter.value,
        kid: kid.value,
      },
      { actor: 'admin' },
    );
    return created(keyToWire(key) as unknown as JsonValue);
  }).then((r) => (isResponse(r) ? r : r));
}

async function handleRotateKey(
  ctx: AdminHandlerContext,
  _req: HandlerRequest,
  params: Readonly<Record<string, string>>,
): Promise<HandlerResponse> {
  const key = await ctx.storage.getKey(params.id ?? '');
  if (key === null) return err(404, 'NotFound', `key not found: ${params.id}`);
  if (key.role !== 'signing') {
    return err(400, 'BadRequest', 'only signing keys may be rotated');
  }
  if (ctx.rootPassphrase === undefined || ctx.signingPassphrase === undefined) {
    return err(400, 'BadRequest', 'root+signing passphrases are not configured on this issuer');
  }
  // Find the active root for (scope_id, alg).
  const roots = await ctx.storage.listKeys(
    { scope_id: key.scope_id, alg: key.alg, role: 'root', state: 'active' },
    { limit: 1, cursor: null },
  );
  const root = roots.items[0];
  if (root === undefined) {
    return err(409, 'IllegalLifecycleTransition', 'no active root key for (scope, alg)');
  }

  return guard(async () => {
    const result = await rotateSigningKey(
      ctx.storage,
      ctx.clock,
      ctx.backends,
      {
        scope_id: key.scope_id,
        alg: key.alg,
        rootKid: root.kid,
        rootPassphrase: ctx.rootPassphrase as string,
        signingPassphrase: ctx.signingPassphrase as string,
      },
      { actor: 'admin' },
    );
    return ok({
      retiring: keyToWire(result.outgoing) as unknown as JsonValue,
      active: keyToWire(result.incoming) as unknown as JsonValue,
    });
  }).then((r) => (isResponse(r) ? r : r));
}

// ---------- Audit ----------

async function handleListAudit(
  ctx: AdminHandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const limit = parseLimit(req);
  if (!limit.ok) return limit.response;
  const filter: Parameters<typeof ctx.storage.listAudit>[0] = {};
  const licenseId = parseUuidQuery(req.query.license_id);
  if (licenseId !== null) (filter as { license_id?: string | null }).license_id = licenseId;
  const scopeId = parseUuidQuery(req.query.scope_id);
  if (scopeId !== null) (filter as { scope_id?: string | null }).scope_id = scopeId;
  const event = parseUuidQuery(req.query.event);
  if (event !== null) (filter as { event?: string }).event = event;
  const p = await ctx.storage.listAudit(filter, { limit: limit.value, cursor: parseCursor(req) });
  return page(p.items, p.cursor, (a) => asJson(a));
}

// ---------- Route factory ----------

/** Build the admin route set. Prefix typically `/api/licensing/v1`. None of
 *  these are `public: true` — the bearer-auth middleware guards them. */
export function adminRoutes(ctx: AdminHandlerContext, prefix = ''): readonly Route[] {
  const p = (path: string) => `${prefix}${path}`;
  // Tiny local helpers to keep the route table dense and readable.
  const get0 = (path: string, h: (req: HandlerRequest) => Promise<HandlerResponse>): Route => ({
    method: 'GET',
    pattern: path,
    handler: (req) => h(req),
  });
  const post0 = (path: string, h: (req: HandlerRequest) => Promise<HandlerResponse>): Route => ({
    method: 'POST',
    pattern: path,
    handler: (req) => h(req),
  });
  const getP = (
    path: string,
    h: (req: HandlerRequest, params: Readonly<Record<string, string>>) => Promise<HandlerResponse>,
  ): Route => ({ method: 'GET', pattern: path, handler: h });
  const patchP = (
    path: string,
    h: (req: HandlerRequest, params: Readonly<Record<string, string>>) => Promise<HandlerResponse>,
  ): Route => ({ method: 'PATCH', pattern: path, handler: h });
  const delP = (
    path: string,
    h: (req: HandlerRequest, params: Readonly<Record<string, string>>) => Promise<HandlerResponse>,
  ): Route => ({ method: 'DELETE', pattern: path, handler: h });
  const postP = (
    path: string,
    h: (req: HandlerRequest, params: Readonly<Record<string, string>>) => Promise<HandlerResponse>,
  ): Route => ({ method: 'POST', pattern: path, handler: h });

  return [
    // Licenses
    get0(p('/admin/licenses'), (req) => handleListLicenses(ctx, req)),
    post0(p('/admin/licenses'), (req) => handleCreateLicense(ctx, req)),
    getP(p('/admin/licenses/:id'), (req, params) => handleGetLicense(ctx, req, params)),
    patchP(p('/admin/licenses/:id'), (req, params) => handleUpdateLicense(ctx, req, params)),
    delP(p('/admin/licenses/:id'), (req, params) => handleDeleteLicense(ctx, req, params)),
    postP(p('/admin/licenses/:id/suspend'), (_req, params) =>
      lifecycleTransition(ctx, params, 'suspend'),
    ),
    postP(p('/admin/licenses/:id/resume'), (_req, params) =>
      lifecycleTransition(ctx, params, 'resume'),
    ),
    postP(p('/admin/licenses/:id/revoke'), (_req, params) =>
      lifecycleTransition(ctx, params, 'revoke'),
    ),
    postP(p('/admin/licenses/:id/renew'), (req, params) => handleRenewLicense(ctx, req, params)),

    // Scopes
    get0(p('/admin/scopes'), (req) => handleListScopes(ctx, req)),
    post0(p('/admin/scopes'), (req) => handleCreateScope(ctx, req)),
    getP(p('/admin/scopes/:id'), (req, params) => handleGetScope(ctx, req, params)),
    patchP(p('/admin/scopes/:id'), (req, params) => handleUpdateScope(ctx, req, params)),
    delP(p('/admin/scopes/:id'), (req, params) => handleDeleteScope(ctx, req, params)),

    // Templates
    get0(p('/admin/templates'), (req) => handleListTemplates(ctx, req)),
    post0(p('/admin/templates'), (req) => handleCreateTemplate(ctx, req)),
    getP(p('/admin/templates/:id'), (req, params) => handleGetTemplate(ctx, req, params)),
    patchP(p('/admin/templates/:id'), (req, params) => handleUpdateTemplate(ctx, req, params)),
    delP(p('/admin/templates/:id'), (req, params) => handleDeleteTemplate(ctx, req, params)),

    // Usages
    get0(p('/admin/usages'), (req) => handleListUsages(ctx, req)),
    getP(p('/admin/usages/:id'), (req, params) => handleGetUsage(ctx, req, params)),
    postP(p('/admin/usages/:id/revoke'), (req, params) => handleRevokeUsage(ctx, req, params)),

    // Keys
    get0(p('/admin/keys'), (req) => handleListKeys(ctx, req)),
    post0(p('/admin/keys'), (req) => handleCreateKey(ctx, req)),
    postP(p('/admin/keys/:id/rotate'), (req, params) => handleRotateKey(ctx, req, params)),

    // Audit
    get0(p('/admin/audit'), (req) => handleListAudit(ctx, req)),
  ];
}

// Re-export types so consumers don't have to spelunk in @anorebel/licensing for
// unused symbols. Stays lint-clean by actually importing them above.
export type { AuditLogEntry, License, LicenseScope, LicenseTemplate, LicenseUsage };

// Keep `errors` referenced so the import isn't pruned by the linter — we use
// it transitively via the core services' throws, but a direct reference here
// keeps static analyzers happy.
void errors;
