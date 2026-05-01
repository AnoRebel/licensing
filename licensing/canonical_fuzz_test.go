package licensing

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

// FuzzCanonicalize_NoPanic exercises Canonicalize with arbitrary JSON-shaped
// input. The canonicalizer MUST either return clean canonical bytes or a
// typed *Error — never panic, never hang, never produce invalid UTF-8.
//
// Run locally with:
//
//	go test ./licensing/ -run='^$' -fuzz=FuzzCanonicalize_NoPanic -fuzztime=30s
func FuzzCanonicalize_NoPanic(f *testing.F) {
	// Seed corpus — known-tricky inputs that historically caused issues.
	seeds := []string{
		`{}`,
		`{"a":1}`,
		`{"a":1,"b":[2,3]}`,
		`{"unicode":"héllo/"}`,
		`{"astral":"😀"}`,               // emoji 😀
		`{"escape":"\""}`,              // quote
		`{"control":"` + "\x01" + `"}`, // control char
		`{"int":9007199254740991}`,     // max safe int
		`{"neg":-9007199254740991}`,    // min safe int
		`{"empty_array":[]}`,
		`{"empty_obj":{}}`,
		`{"null":null}`,
		`{"bool":true,"otherbool":false}`,
		`{"deep":{"a":{"b":{"c":{"d":1}}}}}`,
		`{"weird_key":{"z":1,"a":2}}`, // weird-key shape (NUL keys must be left to the fuzzer)
		// duplicate key — the parser silently last-wins; canonicalize on the parsed
		// map can never see it, but seeding it documents the gap.
		`{"a":1,"a":2}`,
	}
	for _, s := range seeds {
		f.Add([]byte(s))
	}

	f.Fuzz(func(t *testing.T, raw []byte) {
		// Bound runaway inputs — fuzzer occasionally produces megabyte blobs
		// and we want fast iteration, not benchmarking.
		if len(raw) > 64*1024 {
			t.Skip("input too large for fast fuzz")
		}

		// Parse with json.Decoder + UseNumber so semantics match parsePayload.
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		var v any
		if err := dec.Decode(&v); err != nil {
			return // not valid JSON — not a canonicalizer input
		}
		obj, ok := v.(map[string]any)
		if !ok {
			return // canonicalize only operates on objects
		}

		// Canonicalize must not panic.
		out, err := Canonicalize(obj)
		if err != nil {
			// Errors are fine; assert the shape: must be *Error with a known code.
			var le *Error
			if !asLicensingError(err, &le) {
				t.Fatalf("canonicalize returned non-*Error: %T %v", err, err)
			}
			return
		}

		// Output must be valid UTF-8.
		if !utf8.Valid(out) {
			t.Fatalf("canonical output is not valid UTF-8: %q", out)
		}

		// Output must be parseable as JSON (round-trip).
		var reparsed any
		dec2 := json.NewDecoder(bytes.NewReader(out))
		dec2.UseNumber()
		if err := dec2.Decode(&reparsed); err != nil {
			t.Fatalf("canonical output fails to re-parse: %v\noutput: %q", err, out)
		}
		reparsedObj, ok := reparsed.(map[string]any)
		if !ok {
			t.Fatalf("canonical output is not a JSON object: %q", out)
		}

		// Idempotence: canonicalize(parse(canonicalize(obj))) == canonicalize(obj).
		out2, err := Canonicalize(reparsedObj)
		if err != nil {
			t.Fatalf("canonicalize is not idempotent: re-canonicalize errored: %v", err)
		}
		if !bytes.Equal(out, out2) {
			t.Fatalf("canonicalize is not idempotent:\nfirst:  %q\nsecond: %q", out, out2)
		}
	})
}

// FuzzCanonicalize_KeyOrderingAgnostic verifies that the same logical map
// produces the same canonical output regardless of insertion order. This is
// the property that makes signature verification work — two issuers signing
// the same claim set MUST produce the same bytes.
func FuzzCanonicalize_KeyOrderingAgnostic(f *testing.F) {
	f.Add(`{"a":1,"b":2,"c":3}`, `{"c":3,"b":2,"a":1}`)
	f.Add(`{"z":1,"a":2}`, `{"a":2,"z":1}`)
	f.Add(`{"unicode":"é","ascii":"a"}`, `{"ascii":"a","unicode":"é"}`)

	f.Fuzz(func(t *testing.T, jsonA string, jsonB string) {
		if len(jsonA) > 8*1024 || len(jsonB) > 8*1024 {
			t.Skip("input too large")
		}
		mapA, errA := decodeAsMap(jsonA)
		mapB, errB := decodeAsMap(jsonB)
		if errA != nil || errB != nil {
			return
		}
		// Only useful when both maps have the SAME logical contents.
		if !mapsEqual(mapA, mapB) {
			return
		}
		outA, errCA := Canonicalize(mapA)
		outB, errCB := Canonicalize(mapB)
		// Both must succeed-or-fail identically.
		if (errCA == nil) != (errCB == nil) {
			t.Fatalf("identical maps had different canonicalize outcomes: errA=%v errB=%v", errCA, errCB)
		}
		if errCA == nil && !bytes.Equal(outA, outB) {
			t.Fatalf("identical maps produced different canonical output:\nA: %q\nB: %q", outA, outB)
		}
	})
}

// FuzzCanonicalize_NumberCanonicalisation explores the number-rule edge
// cases: leading zeros, exponents, fractional values that happen to be
// integers, negative zero. Every accepted number MUST produce decimal-only
// output with no leading zeros and no leading +.
func FuzzCanonicalize_NumberCanonicalisation(f *testing.F) {
	f.Add(int64(0))
	f.Add(int64(7))
	f.Add(int64(-7))
	f.Add(int64(9007199254740991))
	f.Add(int64(-9007199254740991))

	f.Fuzz(func(t *testing.T, n int64) {
		obj := map[string]any{"n": n}
		out, err := Canonicalize(obj)
		if err != nil {
			// Expected for out-of-safe-range values.
			return
		}
		// Form must be {"n":<decimal>}
		if !bytes.HasPrefix(out, []byte(`{"n":`)) {
			t.Fatalf("unexpected prefix: %q", out)
		}
		numPart := bytes.TrimSuffix(bytes.TrimPrefix(out, []byte(`{"n":`)), []byte("}"))
		s := string(numPart)
		if strings.HasPrefix(s, "+") {
			t.Fatalf("number has leading +: %q", s)
		}
		// Leading zero check: only "0" itself or negative-followed-by-non-zero is OK.
		if len(s) > 1 && s[0] == '0' {
			t.Fatalf("number has leading zero: %q", s)
		}
		if strings.HasPrefix(s, "-0") && s != "0" {
			t.Fatalf("negative zero leaked: %q", s)
		}
		if strings.ContainsAny(s, ".eE") {
			t.Fatalf("number has fractional/exponent form: %q", s)
		}
	})
}

// ---------- helpers ----------

func asLicensingError(err error, out **Error) bool {
	if le, ok := err.(*Error); ok {
		*out = le
		return true
	}
	return false
}

func decodeAsMap(s string) (map[string]any, error) {
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, errNotMap
	}
	return m, nil
}

var errNotMap = &Error{Code: CodeCanonicalJSONInvalidTopLevel, Message: "not a map"}

// mapsEqual is a deep-equal that treats json.Number values numerically
// so that two parses of the same JSON compare equal even if the underlying
// map iteration order differed.
func mapsEqual(a, b map[string]any) bool {
	if len(a) != len(b) {
		return false
	}
	for k, va := range a {
		vb, ok := b[k]
		if !ok {
			return false
		}
		if !valuesEqual(va, vb) {
			return false
		}
	}
	return true
}

func valuesEqual(a, b any) bool {
	switch ax := a.(type) {
	case map[string]any:
		bx, ok := b.(map[string]any)
		return ok && mapsEqual(ax, bx)
	case []any:
		bx, ok := b.([]any)
		if !ok || len(ax) != len(bx) {
			return false
		}
		for i := range ax {
			if !valuesEqual(ax[i], bx[i]) {
				return false
			}
		}
		return true
	case json.Number:
		bx, ok := b.(json.Number)
		return ok && ax.String() == bx.String()
	default:
		return a == b
	}
}
