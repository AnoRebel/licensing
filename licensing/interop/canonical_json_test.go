package interop

import (
	"encoding/base64"
	"encoding/json"
	"math/rand/v2"
	"testing"
	"unicode/utf16"
	"unicode/utf8"

	lic "github.com/AnoRebel/licensing/licensing"
)

// TestCanonicalJSON_TSvsGo_Parity runs a deterministic property test: the
// same pseudo-random corpus of valid-per-LIC1-canonical-json objects is fed
// to both implementations in a single batched bun call. Every pair of
// emitted byte strings must be identical.
//
// The generator only emits shapes that both canonicalizers accept:
//   - top-level map[string]any
//   - leaves: null, bool, string (BMP + a few surrogate-pair code points),
//     int64 within the ±2^53-1 safe-integer window, nested objects, arrays
//   - keys: arbitrary unicode strings (the canonicalizer's UTF-16 codepoint
//     sort is the whole point of this test)
//
// The seed is fixed; bumping the iteration count or the max-depth only
// requires rerunning the test.
func TestCanonicalJSON_TSvsGo_Parity(t *testing.T) {
	requireBun(t)

	const iterations = 10_000
	const seed1 = 0x5eed_1a8f_d00d_cafe
	const seed2 = 0xbadd_f00d_1337_b055

	// Fixed seed → deterministic, but two seeds so t.Parallel subtests
	// can't accidentally share the same sequence.
	r := rand.New(rand.NewPCG(seed1, seed2))

	values := make([]map[string]any, iterations)
	for i := range values {
		values[i] = randomObject(r, 0)
	}

	// Build Go-side canonical bytes up-front.
	goCanon := make([][]byte, iterations)
	for i, v := range values {
		b, err := lic.Canonicalize(v)
		if err != nil {
			t.Fatalf("go canonicalize[%d]: %v (value=%#v)", i, err, v)
		}
		goCanon[i] = b
	}

	// One batched bun call — spawning 10k bun processes would dominate
	// wallclock. canonicalize.ts accepts {values: [...]} and returns
	// {canonical_b64: [...]} in the same order.
	res, err := runBunCLI(t, "canonicalize.ts", map[string]any{"values": values})
	if err != nil {
		t.Fatalf("ts batch canonicalize: %v", err)
	}
	var out struct {
		CanonicalB64 []string `json:"canonical_b64"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		t.Fatalf("decode ts canonicalize response: %v", err)
	}
	if len(out.CanonicalB64) != iterations {
		t.Fatalf("ts returned %d canonicals, want %d", len(out.CanonicalB64), iterations)
	}

	// Diff iteration-by-iteration. On mismatch we print both bytes
	// verbatim (they're UTF-8) so the failure is readable even at 10k
	// — the test stops at the first mismatch.
	for i := range iterations {
		tsCanon, err := base64.StdEncoding.DecodeString(out.CanonicalB64[i])
		if err != nil {
			t.Fatalf("decode ts canonical[%d] b64: %v", i, err)
		}
		if string(goCanon[i]) != string(tsCanon) {
			jsonInput, _ := json.Marshal(values[i])
			t.Fatalf("canonical divergence at iteration %d:\n  input: %s\n  go:    %s\n  ts:    %s",
				i, string(jsonInput), string(goCanon[i]), string(tsCanon))
		}
	}
}

// randomObject builds a top-level map the canonicalizer will accept.
// depth=0 means "we're at the root" — we cap recursion to keep trees small
// enough that 10k iterations finish in a sane wallclock (no explosion).
func randomObject(r *rand.Rand, depth int) map[string]any {
	const maxDepth = 4
	// Root always has at least one key; nested objects can be empty.
	minKeys := 0
	if depth == 0 {
		minKeys = 1
	}
	n := minKeys + r.IntN(5) // 0–4 extra keys
	obj := make(map[string]any, n)
	for range n {
		k := randomKey(r)
		obj[k] = randomValue(r, depth+1, maxDepth)
	}
	return obj
}

func randomArray(r *rand.Rand, depth, maxDepth int) []any {
	n := r.IntN(5)
	arr := make([]any, n)
	for i := range arr {
		arr[i] = randomValue(r, depth+1, maxDepth)
	}
	return arr
}

func randomValue(r *rand.Rand, depth, maxDepth int) any {
	// At max depth we can only emit leaves, no containers.
	kind := r.IntN(7)
	if depth >= maxDepth && (kind == 5 || kind == 6) {
		kind = r.IntN(5)
	}
	switch kind {
	case 0:
		return nil
	case 1:
		return r.IntN(2) == 1
	case 2:
		return randomString(r)
	case 3:
		// Safe-integer window. json.Unmarshal will hand us float64 on
		// the TS side, but our generator emits int64 and Go's
		// Canonicalize accepts ints directly. We pass the object
		// through JSON into bun anyway, so both sides see the same
		// number-shaped input.
		return r.Int64N(1<<40) - (1 << 39)
	case 4:
		// Small integer — ensures we cover single-digit / negative-zero
		// edge cases without drowning in 40-bit randoms.
		return int64(r.IntN(21) - 10)
	case 5:
		return randomObject(r, depth)
	case 6:
		return randomArray(r, depth, maxDepth)
	}
	return nil
}

func randomKey(r *rand.Rand) string {
	// Keys exercise the UTF-16 sort order — use a mix of ASCII, BMP,
	// and a few supplementary-plane codepoints. Empty keys are legal.
	n := r.IntN(6) // 0-5 chars
	return randomUTF8String(r, n)
}

func randomString(r *rand.Rand) string {
	// Value strings: mix escapes, controls, quotes, backslashes, and
	// non-BMP codepoints so the LIC1 escape table is exercised.
	n := r.IntN(8)
	return randomUTF8String(r, n)
}

// randomUTF8String assembles a valid UTF-8 string from a mix of:
//   - ASCII printable + common controls (\b \f \n \r \t \" \\)
//   - BMP codepoints
//   - one-in-N supplementary plane codepoints via surrogate pair logic so
//     we stress the surrogate-sort path of the canonicalizer
func randomUTF8String(r *rand.Rand, n int) string {
	var runes []rune
	for range n {
		switch r.IntN(10) {
		case 0:
			runes = append(runes, rune([]byte{'\b', '\f', '\n', '\r', '\t', '"', '\\', 0x00, 0x01, 0x1f}[r.IntN(10)]))
		case 1, 2, 3, 4, 5:
			// ASCII printable
			runes = append(runes, rune(0x20+r.IntN(0x7e-0x20)))
		case 6, 7, 8:
			// BMP non-surrogate
			var cp rune
			for {
				cp = rune(r.IntN(0xD800)) // 0x0000..0xD7FF — skip surrogates
				if cp >= 0x20 {
					break
				}
			}
			runes = append(runes, cp)
		case 9:
			// Supplementary plane — emit as a valid non-BMP rune.
			// Generates a codepoint in [0x10000, 0x10FFFF].
			cp := rune(0x10000 + r.IntN(0x10FFFF-0x10000+1))
			// Validate it's not an unpaired surrogate (range above already excludes them).
			if utf16.IsSurrogate(cp) {
				cp = 0x1F600 // fallback to a known-good codepoint
			}
			if !utf8.ValidRune(cp) {
				cp = 0x1F600
			}
			runes = append(runes, cp)
		}
	}
	return string(runes)
}
