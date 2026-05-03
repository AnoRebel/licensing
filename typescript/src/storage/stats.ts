// Shared aggregation logic for `Storage.getLicenseStats`.
//
// Each storage adapter pulls the raw rows in whatever way is most
// efficient for its backend (memory: walk Map; SQL: SELECT with scope
// filter), then hands the rows to `computeLicenseStats` for the actual
// roll-up.
//
// Keeping the math here means the cross-port byte-parity contract test
// only needs to verify one implementation — and the three adapters
// can't drift in subtle ordering / rounding ways. The math is also the
// one thing the dashboard cares about, so a single source of truth for
// it is exactly what we want.

import { isoFromMs } from '../id.ts';
import type { License } from '../types.ts';
import type {
  LicenseSeatTopEntry,
  LicenseStats,
  LicenseStatusCounts,
  LicenseTemplateCount,
} from './types.ts';

/** Minimal license shape used by the aggregator — everything we need is
 *  on the wire row, so the adapter doesn't have to round-trip through
 *  the full row mapper if it doesn't want to. */
export interface StatsLicenseRow {
  readonly id: License['id'];
  readonly scope_id: License['scope_id'];
  readonly template_id: License['template_id'];
  readonly status: License['status'];
  readonly max_usages: number;
  readonly expires_at: string | null;
  readonly license_key: string;
}

export interface ComputeLicenseStatsInput {
  /** Licenses already filtered by the adapter's scope predicate. */
  readonly licenses: readonly StatsLicenseRow[];
  /** `license_id` of every `active`-status usage in the same scope.
   *  Duplicates are counted (one entry per usage row). */
  readonly activeUsageLicenseIds: readonly string[];
  /** Event names of audit rows in the trailing 30d (already scope-filtered). */
  readonly auditEvents: readonly string[];
  /** Reference instant for the 30d horizon — milliseconds since epoch. */
  readonly nowMs: number;
}

/** Build a zero-initialised mutable counts record. */
function emptyCounts(): Record<License['status'], number> {
  return { pending: 0, active: 0, grace: 0, expired: 0, suspended: 0, revoked: 0 };
}

export function computeLicenseStats(input: ComputeLicenseStatsInput): LicenseStats {
  const { licenses, activeUsageLicenseIds, auditEvents, nowMs } = input;

  // Counts per status. `as` cast is safe because the input row's status
  // is constrained to the License['status'] union.
  const countsMut = emptyCounts();
  for (const lic of licenses) countsMut[lic.status] += 1;
  const counts: LicenseStatusCounts = { ...countsMut };

  // Expiring within 30d: active licenses whose expires_at is in [now, now+30d].
  const horizonIso = isoFromMs(nowMs + 30 * 24 * 60 * 60 * 1000);
  const nowIso = isoFromMs(nowMs);
  const expiringWithin30d = licenses.filter((lic) => {
    if (lic.status !== 'active') return false;
    if (lic.expires_at === null) return false;
    return lic.expires_at >= nowIso && lic.expires_at <= horizonIso;
  }).length;

  // 30-day audit-derived deltas. One event, one bucket.
  let added = 0;
  let removed = 0;
  for (const ev of auditEvents) {
    switch (ev) {
      case 'license.created':
      case 'license.activated':
        added++;
        break;
      case 'license.revoked':
      case 'license.expired':
      case 'license.suspended':
        removed++;
        break;
      default:
        break;
    }
  }

  // Active-usage counts per license.
  const activeUsagesByLicense = new Map<string, number>();
  for (const id of activeUsageLicenseIds) {
    activeUsagesByLicense.set(id, (activeUsagesByLicense.get(id) ?? 0) + 1);
  }

  // Seat utilisation rolls up only active licenses (per spec).
  const activeLicenses = licenses.filter((lic) => lic.status === 'active');
  let activeUsagesTotal = 0;
  let maxUsagesTotal = 0;
  const utilEntries: Array<{
    license_id: string;
    license_key: string;
    max_usages: number;
    active_usages: number;
    ratio: number;
  }> = [];
  for (const lic of activeLicenses) {
    const used = activeUsagesByLicense.get(lic.id) ?? 0;
    activeUsagesTotal += used;
    maxUsagesTotal += lic.max_usages;
    const ratio = lic.max_usages > 0 ? used / lic.max_usages : 0;
    utilEntries.push({
      license_id: lic.id,
      license_key: lic.license_key,
      max_usages: lic.max_usages,
      active_usages: used,
      ratio,
    });
  }
  // Top 10 by ratio DESC; ties → active_usages DESC, id ASC.
  utilEntries.sort((a, b) => {
    if (a.ratio !== b.ratio) return b.ratio - a.ratio;
    if (a.active_usages !== b.active_usages) return b.active_usages - a.active_usages;
    return a.license_id < b.license_id ? -1 : 1;
  });
  const topN: LicenseSeatTopEntry[] = utilEntries.slice(0, 10).map((e) => ({
    license_id: e.license_id,
    license_key: e.license_key,
    max_usages: e.max_usages,
    active_usages: e.active_usages,
  }));

  // Top templates by license_count across all statuses.
  const templateCounts = new Map<string, number>();
  for (const lic of licenses) {
    if (lic.template_id === null) continue;
    templateCounts.set(lic.template_id, (templateCounts.get(lic.template_id) ?? 0) + 1);
  }
  const topTemplates: LicenseTemplateCount[] = [...templateCounts.entries()]
    .sort(([aId, aCount], [bId, bCount]) => {
      if (aCount !== bCount) return bCount - aCount;
      return aId < bId ? -1 : 1;
    })
    .slice(0, 10)
    .map(([template_id, license_count]) => ({ template_id, license_count }));

  return {
    counts,
    expiring_within_30d: expiringWithin30d,
    active_delta_30d: { added, removed },
    seat_utilization: {
      active_usages_total: activeUsagesTotal,
      max_usages_total: maxUsagesTotal,
      top_n: topN,
    },
    top_templates: topTemplates,
  };
}
