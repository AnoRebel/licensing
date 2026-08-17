package licensing

import "testing"

// TestDefaultMakeKid_CarriesRandomness guards a bug where the default kid
// was built from the leading 12 hex of a UUIDv7 — which ARE the 48-bit
// millisecond timestamp (RFC 9562 §5.7), so the kid carried no randomness
// and every key minted in the same millisecond collided. A tight loop
// produced 3 distinct kids out of 200 before the fix.
func TestDefaultMakeKid_CarriesRandomness(t *testing.T) {
	const n = 200
	seen := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		seen[defaultMakeKid(RoleSigning, NewUUIDv7())] = struct{}{}
	}
	// Allow a little birthday slack on the random suffix, but anything
	// near the millisecond-collision regime (single digits) is the bug.
	if len(seen) < n-5 {
		t.Fatalf("kid entropy collapsed: only %d distinct kids from %d ids", len(seen), n)
	}
}

// TestDefaultMakeKid_MatchesTypeScript pins the exact kid formula shared
// with the TS port. Both must format the same UUID identically or the
// ports diverge on a value that is persisted and looked up by KID.
func TestDefaultMakeKid_MatchesTypeScript(t *testing.T) {
	got := defaultMakeKid(RoleRoot, "01234567-89ab-7cde-8f01-234567890abc")
	if want := "root-0123456789ab-8f01"; got != want {
		t.Fatalf("kid formula diverged from the TS port: got %q want %q", got, want)
	}
	// A non-UUID id must keep its full value rather than being truncated
	// down to whatever the first 12 characters happen to be.
	if got := defaultMakeKid(RoleSigning, "custom-id"); got != "signing-custom-id" {
		t.Fatalf("non-UUID fallback lost data: %q", got)
	}
}
