package licensing

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// Safe-integer bounds — mirror TypeScript's Number.MAX_SAFE_INTEGER / MIN_SAFE_INTEGER.
const (
	maxSafeInteger = int64(1)<<53 - 1 // 9_007_199_254_740_991
	minSafeInteger = -(int64(1)<<53 - 1)
)

// Canonicalize produces the canonical UTF-8 byte sequence for value. The
// rules are defined in fixtures/README.md and mirrored verbatim by
// typescript/packages/core/src/canonical-json.ts. Byte-for-byte parity with
// the TS canonicalizer is part of the contract.
//
// Accepted value shapes:
//
//   - nil                                  → null
//   - bool                                 → true / false
//   - string                               → quoted, with LIC1 escape rules
//   - int / int8…int64 / uint…uint64       → decimal integer (within safe range)
//   - json.Number                          → parsed as int64; rejected if fractional
//   - float64                              → accepted only if an exact safe integer
//   - []any                                → JSON array
//   - map[string]any                       → JSON object (keys sorted by UTF-16)
//
// Everything else (time.Time, structs, channels, functions, etc.) is
// rejected with ErrCanonicalJSONInvalidType. The top-level value must be a
// map[string]any or a *json.Decoder-decoded object; anything else returns
// ErrCanonicalJSONInvalidTopLevel.
func Canonicalize(value any) ([]byte, error) {
	obj, ok := value.(map[string]any)
	if !ok {
		return nil, canonicalInvalidTopLevel("canonical JSON top-level must be a plain object")
	}
	var buf bytes.Buffer
	if err := writeObject(obj, &buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// CanonicalizeToString is a convenience wrapper that returns the canonical
// byte sequence as a string. The result is valid UTF-8.
func CanonicalizeToString(value any) (string, error) {
	b, err := Canonicalize(value)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// --- internals -----------------------------------------------------------

func writeValue(v any, out *bytes.Buffer) error {
	if v == nil {
		out.WriteString("null")
		return nil
	}

	switch x := v.(type) {
	case bool:
		if x {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
		return nil

	case string:
		return writeString(x, out)

	case json.Number:
		// Reject any decimal/exponent form — canonical JSON is integer-only.
		if i, err := x.Int64(); err == nil {
			return writeInt64(i, out)
		}
		return canonicalInvalidNumber(
			"non-integer number not permitted",
			map[string]any{"value": x.String()})

	case int:
		return writeInt64(int64(x), out)
	case int8:
		return writeInt64(int64(x), out)
	case int16:
		return writeInt64(int64(x), out)
	case int32:
		return writeInt64(int64(x), out)
	case int64:
		return writeInt64(x, out)
	case uint:
		return writeUint64(uint64(x), out)
	case uint8:
		return writeInt64(int64(x), out)
	case uint16:
		return writeInt64(int64(x), out)
	case uint32:
		return writeInt64(int64(x), out)
	case uint64:
		return writeUint64(x, out)

	case float32:
		return writeFloat(float64(x), out)
	case float64:
		return writeFloat(x, out)

	case []any:
		return writeArray(x, out)

	case map[string]any:
		return writeObject(x, out)
	}

	return canonicalInvalidType(
		fmt.Sprintf("unsupported type: %T", v),
		map[string]any{"type": fmt.Sprintf("%T", v)})
}

func writeInt64(n int64, out *bytes.Buffer) error {
	if n > maxSafeInteger || n < minSafeInteger {
		return canonicalInvalidNumber(
			"integer outside safe range",
			map[string]any{"value": n})
	}
	out.WriteString(strconv.FormatInt(n, 10))
	return nil
}

func writeUint64(n uint64, out *bytes.Buffer) error {
	if n > uint64(maxSafeInteger) {
		return canonicalInvalidNumber(
			"integer outside safe range",
			map[string]any{"value": n})
	}
	out.WriteString(strconv.FormatUint(n, 10))
	return nil
}

func writeFloat(f float64, out *bytes.Buffer) error {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return canonicalInvalidNumber("NaN or Infinity not permitted", nil)
	}
	// Reject negative zero — its bit pattern differs from +0 in IEEE 754,
	// and emitting "0" for -0 would disagree with the TS path which throws.
	if f == 0 && math.Signbit(f) {
		return canonicalInvalidNumber("negative zero not permitted", nil)
	}
	if math.Trunc(f) != f {
		return canonicalInvalidNumber(
			"non-integer number not permitted",
			map[string]any{"value": f})
	}
	if f > float64(maxSafeInteger) || f < float64(minSafeInteger) {
		return canonicalInvalidNumber(
			"integer outside safe range",
			map[string]any{"value": f})
	}
	// strconv.FormatFloat with 'f'/-1 would print "1700000000" for
	// whole-number float64 values — but also "1e+20" for larger ones. Since
	// we've already asserted the value is an exact safe integer, convert
	// through int64 for a minimal decimal representation that matches the
	// TS Number.toString(10) output.
	out.WriteString(strconv.FormatInt(int64(f), 10))
	return nil
}

func writeArray(a []any, out *bytes.Buffer) error {
	out.WriteByte('[')
	for i, v := range a {
		if i > 0 {
			out.WriteByte(',')
		}
		if err := writeValue(v, out); err != nil {
			return err
		}
	}
	out.WriteByte(']')
	return nil
}

func writeObject(o map[string]any, out *bytes.Buffer) error {
	keys := make([]string, 0, len(o))
	for k := range o {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		return compareUTF16(keys[i], keys[j]) < 0
	})

	out.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			out.WriteByte(',')
		}
		if err := writeString(k, out); err != nil {
			return err
		}
		out.WriteByte(':')
		if err := writeValue(o[k], out); err != nil {
			return err
		}
	}
	out.WriteByte('}')
	return nil
}

// compareUTF16 compares two UTF-8 strings as if they were UTF-16 code-unit
// sequences — the JS default string comparator semantics that canonical JSON
// mandates. Strings in Go are UTF-8, so we transcode on the fly (no
// allocation in the common BMP-only case).
//
// Returns -1 if a < b, 0 if equal, +1 if a > b.
func compareUTF16(a, b string) int {
	// Fast path for ASCII-only strings — byte comparison == UTF-16 comparison.
	if isASCII(a) && isASCII(b) {
		switch {
		case a < b:
			return -1
		case a > b:
			return 1
		default:
			return 0
		}
	}
	au := utf16.Encode([]rune(a))
	bu := utf16.Encode([]rune(b))
	for i := 0; i < len(au) && i < len(bu); i++ {
		if au[i] != bu[i] {
			if au[i] < bu[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(au) < len(bu):
		return -1
	case len(au) > len(bu):
		return 1
	default:
		return 0
	}
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

const hexDigits = "0123456789abcdef"

func writeString(s string, out *bytes.Buffer) error {
	if !utf8.ValidString(s) {
		return canonicalInvalidUTF8("string input is not valid UTF-8", nil)
	}

	out.WriteByte('"')
	for i := 0; i < len(s); {
		b := s[i]
		// ASCII fast path handles the common case.
		if b < 0x80 {
			switch b {
			case 0x22:
				out.WriteString(`\"`)
			case 0x5c:
				out.WriteString(`\\`)
			case 0x08:
				out.WriteString(`\b`)
			case 0x09:
				out.WriteString(`\t`)
			case 0x0a:
				out.WriteString(`\n`)
			case 0x0c:
				out.WriteString(`\f`)
			case 0x0d:
				out.WriteString(`\r`)
			default:
				if b < 0x20 {
					out.WriteString(`\u00`)
					out.WriteByte(hexDigits[(b>>4)&0x0f])
					out.WriteByte(hexDigits[b&0x0f])
				} else {
					// Includes '/' — NOT escaped.
					out.WriteByte(b)
				}
			}
			i++
			continue
		}
		// Non-ASCII rune: emit raw UTF-8 bytes (DecodeRuneInString already
		// validated well-formedness via utf8.ValidString above).
		_, size := utf8.DecodeRuneInString(s[i:])
		out.WriteString(s[i : i+size])
		i += size
	}
	out.WriteByte('"')
	return nil
}
