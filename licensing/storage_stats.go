package licensing

// Shared aggregation logic for Storage.GetLicenseStats. Mirrors
// typescript/src/storage/stats.ts byte-for-byte; the cross-port
// contract test enforces parity.
//
// Each adapter pulls raw rows however it likes (memory: walk maps;
// SQL: SELECT with scope filter), then hands them to ComputeLicenseStats
// for the actual roll-up. Centralising the math keeps the three
// adapters from drifting on subtle ordering / rounding details, and
// makes the wire shape testable in one place.

import (
	"sort"
	"time"
)

// IsoFromMs formats a Unix-millis instant as the canonical ISO-8601
// timestamp with microsecond precision and a `Z` suffix. Matches the
// TS port's `isoFromMs` so cross-port comparisons over ISO strings
// stay byte-stable.
func IsoFromMs(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000000Z")
}

// MsFromIso parses one of our canonical ISO-8601 strings back to
// milliseconds since epoch. Returns 0 on parse failure (caller-side
// logic treats that as "out of window", which is conservative).
func MsFromIso(iso string) int64 {
	t, err := time.Parse("2006-01-02T15:04:05.000000Z", iso)
	if err != nil {
		// Try the broader RFC3339Nano format — older fixtures + tests
		// occasionally use this without the explicit microsecond pad.
		t, err = time.Parse(time.RFC3339Nano, iso)
		if err != nil {
			return 0
		}
	}
	return t.UTC().UnixMilli()
}

// StatsLicenseRow is the minimal license shape ComputeLicenseStats
// needs. Adapters can satisfy it directly with the wire row or build
// it from a fuller mapper; the field set is what matters.
type StatsLicenseRow struct {
	ScopeID    *string
	TemplateID *string
	ExpiresAt  *string
	ID         string
	Status     LicenseStatus
	LicenseKey string
	MaxUsages  int
}

// ComputeLicenseStatsInput bundles the rows the aggregator needs.
// Adapters scope-filter before passing them in.
type ComputeLicenseStatsInput struct {
	// Licenses already filtered by the adapter's scope predicate.
	Licenses []StatsLicenseRow
	// LicenseID of every active-status usage in the same scope.
	// Duplicates count (one entry per usage row).
	ActiveUsageLicenseIDs []string
	// Event names of audit rows in the trailing 30d (already scope-filtered).
	AuditEvents []string
	// Reference instant for the 30d horizon.
	NowMs int64
}

// ComputeLicenseStats rolls up the input into the wire-shape stats
// payload. Sort keys + tiebreakers match the TS port verbatim — a
// future drift on either side breaks the cross-port contract test.
func ComputeLicenseStats(in ComputeLicenseStatsInput) *LicenseStats {
	// --- counts (zero-fill) -----------------------------------------
	counts := LicenseStatusCounts{}
	for _, lic := range in.Licenses {
		switch lic.Status {
		case "pending":
			counts.Pending++
		case "active":
			counts.Active++
		case "grace":
			counts.Grace++
		case "expired":
			counts.Expired++
		case "suspended":
			counts.Suspended++
		case "revoked":
			counts.Revoked++
		}
	}

	// --- expiring within 30d ----------------------------------------
	now := time.UnixMilli(in.NowMs).UTC()
	horizon := now.Add(30 * 24 * time.Hour)
	nowIso := now.Format("2006-01-02T15:04:05.000000Z")
	horizonIso := horizon.Format("2006-01-02T15:04:05.000000Z")
	expiring := 0
	for _, lic := range in.Licenses {
		if lic.Status != "active" || lic.ExpiresAt == nil {
			continue
		}
		// ISO comparison is fine because storage normalises every
		// timestamp to UTC `Z` with the same prefix. See
		// licensing/clock.go for the canonical formatter.
		if *lic.ExpiresAt >= nowIso && *lic.ExpiresAt <= horizonIso {
			expiring++
		}
	}

	// --- 30d audit-derived deltas -----------------------------------
	added, removed := 0, 0
	for _, ev := range in.AuditEvents {
		switch ev {
		case "license.created", "license.activated":
			added++
		case "license.revoked", "license.expired", "license.suspended":
			removed++
		}
	}

	// --- active-usage counts per license ----------------------------
	activeUsages := map[string]int{}
	for _, id := range in.ActiveUsageLicenseIDs {
		activeUsages[id]++
	}

	// --- seat utilisation -------------------------------------------
	type utilEntry struct {
		LicenseID    string
		LicenseKey   string
		MaxUsages    int
		ActiveUsages int
		Ratio        float64
	}
	var utilTotal, maxTotal int
	utilEntries := make([]utilEntry, 0)
	for _, lic := range in.Licenses {
		if lic.Status != "active" {
			continue
		}
		used := activeUsages[lic.ID]
		utilTotal += used
		maxTotal += lic.MaxUsages
		ratio := 0.0
		if lic.MaxUsages > 0 {
			ratio = float64(used) / float64(lic.MaxUsages)
		}
		utilEntries = append(utilEntries, utilEntry{
			LicenseID:    lic.ID,
			LicenseKey:   lic.LicenseKey,
			MaxUsages:    lic.MaxUsages,
			ActiveUsages: used,
			Ratio:        ratio,
		})
	}
	// Top 10 by ratio DESC, ties → active_usages DESC, id ASC.
	sort.SliceStable(utilEntries, func(i, j int) bool {
		if utilEntries[i].Ratio != utilEntries[j].Ratio {
			return utilEntries[i].Ratio > utilEntries[j].Ratio
		}
		if utilEntries[i].ActiveUsages != utilEntries[j].ActiveUsages {
			return utilEntries[i].ActiveUsages > utilEntries[j].ActiveUsages
		}
		return utilEntries[i].LicenseID < utilEntries[j].LicenseID
	})
	if len(utilEntries) > 10 {
		utilEntries = utilEntries[:10]
	}
	topN := make([]LicenseSeatTopEntry, len(utilEntries))
	for i, e := range utilEntries {
		topN[i] = LicenseSeatTopEntry{
			LicenseID:    e.LicenseID,
			LicenseKey:   e.LicenseKey,
			MaxUsages:    e.MaxUsages,
			ActiveUsages: e.ActiveUsages,
		}
	}

	// --- top templates -----------------------------------------------
	tmplCounts := map[string]int{}
	for _, lic := range in.Licenses {
		if lic.TemplateID == nil {
			continue
		}
		tmplCounts[*lic.TemplateID]++
	}
	type tmplPair struct {
		ID    string
		Count int
	}
	pairs := make([]tmplPair, 0, len(tmplCounts))
	for id, c := range tmplCounts {
		pairs = append(pairs, tmplPair{id, c})
	}
	sort.SliceStable(pairs, func(i, j int) bool {
		if pairs[i].Count != pairs[j].Count {
			return pairs[i].Count > pairs[j].Count
		}
		return pairs[i].ID < pairs[j].ID
	})
	if len(pairs) > 10 {
		pairs = pairs[:10]
	}
	topTemplates := make([]LicenseTemplateCount, len(pairs))
	for i, p := range pairs {
		topTemplates[i] = LicenseTemplateCount{TemplateID: p.ID, LicenseCount: p.Count}
	}

	return &LicenseStats{
		Counts:            counts,
		ExpiringWithin30d: expiring,
		ActiveDelta30d:    LicenseDelta30d{Added: added, Removed: removed},
		SeatUtilization: LicenseSeatUtilization{
			ActiveUsagesTotal: utilTotal,
			MaxUsagesTotal:    maxTotal,
			TopN:              topN,
		},
		TopTemplates: topTemplates,
	}
}
