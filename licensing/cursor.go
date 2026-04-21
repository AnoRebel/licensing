package licensing

import (
	"encoding/base64"
	"encoding/json"
)

// Opaque cursor encoding for list pagination.
//
// The canonical ordering used by all Storage adapters is
// (created_at DESC, id DESC). A cursor captures the tuple of the LAST row
// on the previous page; the next call returns rows strictly AFTER that
// tuple under the same ordering.
//
// Encoding is base64url of a tiny JSON blob — opaque to the caller,
// stable across process restarts. A malformed cursor is treated as
// "first page" rather than an error: this mirrors Postgres/SQLite
// adapter behavior where a stale cursor pointing at a since-deleted row
// gracefully resumes from the start of the set.
//
// The JSON field names ("c", "i") are short on purpose to keep encoded
// cursors compact and byte-identical to the TS adapter's output — the
// cross-language interop tests decode TS-issued cursors with the Go
// adapter and vice versa.

// CursorTuple is the decoded cursor payload. CreatedAt is an ISO-8601 /
// RFC 3339 string; ID is a UUIDv7.
type CursorTuple struct {
	CreatedAt string
	ID        string
}

// cursorPayload is the on-the-wire JSON shape. Keep field names short
// ("c"/"i") to match the TS adapter byte-for-byte.
type cursorPayload struct {
	C string `json:"c"`
	I string `json:"i"`
}

// EncodeCursor produces a base64url-encoded opaque cursor from a tuple.
func EncodeCursor(t CursorTuple) string {
	// Marshal can't fail for a struct of two strings.
	b, _ := json.Marshal(cursorPayload{C: t.CreatedAt, I: t.ID})
	return base64.RawURLEncoding.EncodeToString(b)
}

// DecodeCursor parses an opaque cursor. Empty or malformed input returns
// (zero, false) so callers start from the beginning — never an error,
// matching the TS adapter's tolerant posture toward stale cursors.
func DecodeCursor(s string) (CursorTuple, bool) {
	if s == "" {
		return CursorTuple{}, false
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return CursorTuple{}, false
	}
	var p cursorPayload
	if err := json.Unmarshal(b, &p); err != nil {
		return CursorTuple{}, false
	}
	if p.C == "" || p.I == "" {
		return CursorTuple{}, false
	}
	return CursorTuple{CreatedAt: p.C, ID: p.I}, true
}

// CompareDesc implements (created_at DESC, id DESC). Returns negative
// when a sorts before b, positive when a sorts after b, zero when equal.
// Ties on created_at are broken by id, which is UUIDv7, so id-DESC means
// "most-recently-inserted first" within the same millisecond.
func CompareDesc(aCreatedAt, aID, bCreatedAt, bID string) int {
	switch {
	case aCreatedAt != bCreatedAt:
		if aCreatedAt < bCreatedAt {
			return 1
		}
		return -1
	case aID != bID:
		if aID < bID {
			return 1
		}
		return -1
	default:
		return 0
	}
}

// IsAfter reports whether (rowCreatedAt, rowID) comes strictly AFTER the
// cursor tuple under the DESC order — i.e., "lexicographically smaller."
// Callers use this to skip rows up to and including the cursor's row.
func IsAfter(rowCreatedAt, rowID string, c CursorTuple) bool {
	if rowCreatedAt != c.CreatedAt {
		return rowCreatedAt < c.CreatedAt
	}
	return rowID < c.ID
}
