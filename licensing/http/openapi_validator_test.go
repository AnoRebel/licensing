package http

import (
	"fmt"
	"regexp"
	"strings"
)

// Minimal OpenAPI 3.1 schema validator — just enough to assert contract
// conformance on the licensing-admin spec without pulling in a full
// JSON-Schema library. Mirrors the TS companion at
// typescript/packages/http-handlers/tests/openapi-validator.ts.
//
// What we validate:
//   - type (string / number / integer / boolean / object / array / null)
//   - required (object property presence)
//   - properties (recursive)
//   - additionalProperties: false (unknown key rejection)
//   - items (array element schema)
//   - enum (membership)
//   - const (strict equality)
//   - pattern (string regex)
//   - minimum / maximum (numbers)
//   - minLength / maxLength (strings)
//   - nullable: true (3.0) and type: [..., "null"] (3.1)
//   - allOf (shallow merge)
//   - $ref (local #/components/schemas/... only)
//
// Out of scope (not used by our spec): oneOf, anyOf, not, discriminator,
// remote refs, format-validation beyond regex.

type validationError struct {
	Path    string
	Message string
}

func (e validationError) String() string {
	p := e.Path
	if p == "" {
		p = "<root>"
	}
	return fmt.Sprintf("  • %s: %s", p, e.Message)
}

// openAPIDoc is the minimal shape the validator needs from a parsed spec.
// It's wide enough to be populated by yaml.Unmarshal into map[string]any
// and then coerced.
type openAPIDoc struct {
	// schemas is the resolved #/components/schemas/ map, keyed by name.
	// Values are raw schema maps (the validator walks them dynamically so
	// it doesn't need a typed struct mirror).
	schemas map[string]map[string]any
}

// newOpenAPIDoc extracts #/components/schemas from a parsed YAML doc.
// The YAML library returns map[string]any / []any / primitives — we keep
// the whole tree dynamic because a typed mirror would fight the OpenAPI
// document's use of inline schemas, $ref, allOf, etc.
func newOpenAPIDoc(raw any) (*openAPIDoc, error) {
	top, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("openapi root: want map, got %T", raw)
	}
	comps, _ := top["components"].(map[string]any)
	if comps == nil {
		return nil, fmt.Errorf("openapi root: missing `components`")
	}
	schemas, _ := comps["schemas"].(map[string]any)
	if schemas == nil {
		return nil, fmt.Errorf("openapi root: missing `components.schemas`")
	}
	out := make(map[string]map[string]any, len(schemas))
	for name, v := range schemas {
		m, ok := v.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("schema %q is %T, want map", name, v)
		}
		out[name] = m
	}
	return &openAPIDoc{schemas: out}, nil
}

// schema returns a named schema or panics — the caller is a test that
// hand-wrote the name, so a panic is the right failure mode.
func (d *openAPIDoc) schema(name string) map[string]any {
	s, ok := d.schemas[name]
	if !ok {
		panic(fmt.Sprintf("openapi schema not found: %q", name))
	}
	return s
}

// resolveRef follows a local #/components/schemas/... reference.
func (d *openAPIDoc) resolveRef(ref string) (map[string]any, error) {
	const prefix = "#/components/schemas/"
	if !strings.HasPrefix(ref, prefix) {
		return nil, fmt.Errorf("unsupported $ref: %s", ref)
	}
	name := ref[len(prefix):]
	s, ok := d.schemas[name]
	if !ok {
		return nil, fmt.Errorf("$ref not found: %s", ref)
	}
	return s, nil
}

// validate returns a list of validation errors (empty = valid).
func (d *openAPIDoc) validate(schema map[string]any, value any, path string) []validationError {
	// $ref resolves first.
	if ref, ok := schema["$ref"].(string); ok {
		resolved, err := d.resolveRef(ref)
		if err != nil {
			return []validationError{{Path: path, Message: err.Error()}}
		}
		return d.validate(resolved, value, path)
	}

	// allOf — flatten and validate against the merge.
	if allOf, ok := schema["allOf"].([]any); ok && len(allOf) > 0 {
		return d.validate(d.flattenAllOf(allOf), value, path)
	}

	var errs []validationError

	// Nullability.
	nullable := false
	if n, ok := schema["nullable"].(bool); ok && n {
		nullable = true
	}
	types := typeSlice(schema["type"])
	if contains(types, "null") {
		nullable = true
	}

	if value == nil {
		if nullable || contains(types, "null") {
			return errs
		}
		if len(types) > 0 {
			errs = append(errs, validationError{Path: path, Message: fmt.Sprintf("expected %s, got null", strings.Join(types, "|"))})
		}
		return errs
	}

	// Type check (excluding "null").
	if len(types) > 0 {
		nonNull := make([]string, 0, len(types))
		for _, t := range types {
			if t != "null" {
				nonNull = append(nonNull, t)
			}
		}
		if len(nonNull) > 0 {
			matched := false
			for _, t := range nonNull {
				if matchesType(value, t) {
					matched = true
					break
				}
			}
			if !matched {
				errs = append(errs, validationError{Path: path, Message: fmt.Sprintf("expected %s, got %s", strings.Join(nonNull, "|"), typeOf(value))})
				return errs
			}
		}
	}

	// const — strict equality via fmt (sufficient for strings/numbers/bools).
	if c, ok := schema["const"]; ok {
		if fmt.Sprintf("%v", c) != fmt.Sprintf("%v", value) {
			errs = append(errs, validationError{Path: path, Message: fmt.Sprintf("expected const %v, got %v", c, value)})
		}
	}

	// enum.
	if e, ok := schema["enum"].([]any); ok {
		found := false
		for _, candidate := range e {
			if fmt.Sprintf("%v", candidate) == fmt.Sprintf("%v", value) {
				found = true
				break
			}
		}
		if !found {
			errs = append(errs, validationError{Path: path, Message: fmt.Sprintf("not in enum: %v", value)})
		}
	}

	// String constraints.
	if s, ok := value.(string); ok {
		if pat, ok := schema["pattern"].(string); ok {
			re, err := regexp.Compile(pat)
			if err != nil {
				errs = append(errs, validationError{Path: path, Message: fmt.Sprintf("bad pattern %q: %v", pat, err)})
			} else if !re.MatchString(s) {
				errs = append(errs, validationError{Path: path, Message: fmt.Sprintf("pattern /%s/ did not match %q", pat, s)})
			}
		}
		if n, ok := numeric(schema["minLength"]); ok && len(s) < int(n) {
			errs = append(errs, validationError{Path: path, Message: fmt.Sprintf("minLength %v, got %d", n, len(s))})
		}
		if n, ok := numeric(schema["maxLength"]); ok && len(s) > int(n) {
			errs = append(errs, validationError{Path: path, Message: fmt.Sprintf("maxLength %v, got %d", n, len(s))})
		}
	}

	// Number constraints.
	if n, ok := numeric(value); ok {
		if lo, ok := numeric(schema["minimum"]); ok && n < lo {
			errs = append(errs, validationError{Path: path, Message: fmt.Sprintf("minimum %v, got %v", lo, n)})
		}
		if hi, ok := numeric(schema["maximum"]); ok && n > hi {
			errs = append(errs, validationError{Path: path, Message: fmt.Sprintf("maximum %v, got %v", hi, n)})
		}
	}

	// Object shape.
	if obj, ok := value.(map[string]any); ok {
		props, _ := schema["properties"].(map[string]any)
		required, _ := schema["required"].([]any)

		for _, r := range required {
			name, _ := r.(string)
			if _, ok := obj[name]; !ok {
				errs = append(errs, validationError{Path: pathOr(path), Message: fmt.Sprintf("missing required property: %s", name)})
			}
		}

		// additionalProperties: false
		if ap, ok := schema["additionalProperties"]; ok {
			if b, ok := ap.(bool); ok && !b {
				for key := range obj {
					if _, known := props[key]; !known {
						errs = append(errs, validationError{Path: pathOr(path), Message: fmt.Sprintf("unknown property: %s", key)})
					}
				}
			}
		}

		for key, sub := range props {
			subSchema, _ := sub.(map[string]any)
			if subSchema == nil {
				continue
			}
			if val, present := obj[key]; present {
				childPath := key
				if path != "" {
					childPath = path + "." + key
				}
				errs = append(errs, d.validate(subSchema, val, childPath)...)
			}
		}
	}

	// Array items.
	if arr, ok := value.([]any); ok {
		if items, ok := schema["items"].(map[string]any); ok {
			for i, v := range arr {
				errs = append(errs, d.validate(items, v, fmt.Sprintf("%s[%d]", path, i))...)
			}
		}
	}

	return errs
}

// flattenAllOf merges an allOf chain into one effective schema. Only handles
// the shape our spec uses (non-conflicting property/required/items merges).
func (d *openAPIDoc) flattenAllOf(parts []any) map[string]any {
	merged := map[string]any{
		"properties": map[string]any{},
	}
	var req []any

	for _, raw := range parts {
		part, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if ref, ok := part["$ref"].(string); ok {
			resolved, err := d.resolveRef(ref)
			if err == nil {
				part = resolved
			}
		}
		if t, ok := part["type"]; ok {
			merged["type"] = t
		}
		if p, ok := part["properties"].(map[string]any); ok {
			mp := merged["properties"].(map[string]any)
			for k, v := range p {
				mp[k] = v
			}
		}
		if r, ok := part["required"].([]any); ok {
			req = append(req, r...)
		}
		if ap, ok := part["additionalProperties"]; ok {
			merged["additionalProperties"] = ap
		}
		if items, ok := part["items"]; ok {
			merged["items"] = items
		}
	}
	if len(req) > 0 {
		merged["required"] = req
	}
	return merged
}

// ---- helpers ----

func typeOf(v any) string {
	switch n := v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case string:
		return "string"
	case int, int32, int64:
		return "integer"
	case float64:
		// yaml.v3 produces int for integer-valued yaml but float64 for decimals.
		if n == float64(int64(n)) {
			return "integer"
		}
		return "number"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	default:
		return fmt.Sprintf("%T", v)
	}
}

func matchesType(v any, expected string) bool {
	switch expected {
	case "null":
		return v == nil
	case "boolean":
		_, ok := v.(bool)
		return ok
	case "string":
		_, ok := v.(string)
		return ok
	case "integer":
		switch n := v.(type) {
		case int, int32, int64:
			return true
		case float64:
			return n == float64(int64(n))
		}
		return false
	case "number":
		switch v.(type) {
		case int, int32, int64, float64:
			return true
		}
		return false
	case "array":
		_, ok := v.([]any)
		return ok
	case "object":
		_, ok := v.(map[string]any)
		return ok
	}
	return false
}

func numeric(v any) (float64, bool) {
	switch n := v.(type) {
	case int:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case float64:
		return n, true
	}
	return 0, false
}

func typeSlice(v any) []string {
	switch t := v.(type) {
	case string:
		return []string{t}
	case []any:
		out := make([]string, 0, len(t))
		for _, x := range t {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func contains(xs []string, target string) bool {
	for _, x := range xs {
		if x == target {
			return true
		}
	}
	return false
}

func pathOr(p string) string {
	if p == "" {
		return "<root>"
	}
	return p
}

func joinErrors(errs []validationError) string {
	if len(errs) == 0 {
		return ""
	}
	lines := make([]string, 0, len(errs))
	for _, e := range errs {
		lines = append(lines, e.String())
	}
	return strings.Join(lines, "\n")
}
