// Package templates implements the inheritance resolver used by issuers to
// merge a LicenseTemplate's entitlements and meta with its ancestors at
// issue time.
//
// Mirrors typescript/src/templates/resolve.ts byte-for-byte in semantics:
// child-wins deep-merge, depth cap of 5 ancestors with a warning, halt on
// cycles without throwing.
package templates

import (
	"context"
	"log/slog"
	"maps"

	lic "github.com/AnoRebel/licensing/licensing"
)

// MaxDepth is the cap on ancestor walks. Beyond this we log and stop.
const MaxDepth = 5

// Loader fetches a template by id. Returns (nil, nil) when missing.
type Loader func(ctx context.Context, id string) (*lic.LicenseTemplate, error)

// Resolved is the leaf template plus walker outputs.
type Resolved struct {
	*lic.LicenseTemplate
	Entitlements   map[string]any
	Meta           map[string]any
	InheritedDepth int
	Truncated      bool
}

// Resolve walks the parent chain of leaf and returns the effective
// entitlements + meta with child-wins deep-merge. Other inheritable fields
// pass through from leaf unchanged. The returned Resolved's Entitlements
// and Meta are NEW maps; inputs are never mutated.
func Resolve(ctx context.Context, leaf *lic.LicenseTemplate, loader Loader, logger *slog.Logger) (*Resolved, error) {
	if logger == nil {
		logger = slog.Default()
	}
	chain := make([]*lic.LicenseTemplate, 0, MaxDepth)
	visited := map[string]bool{leaf.ID: true}
	cursor := leaf.ParentID
	truncated := false
	for cursor != nil {
		if len(chain) >= MaxDepth {
			truncated = true
			logger.Warn("template inheritance walk hit depth cap",
				"leaf_id", leaf.ID, "leaf_name", leaf.Name, "cap", MaxDepth)
			break
		}
		if visited[*cursor] {
			logger.Warn("template inheritance chain revisits a node; halting walk",
				"leaf_id", leaf.ID, "leaf_name", leaf.Name, "revisited", *cursor)
			break
		}
		visited[*cursor] = true
		node, err := loader(ctx, *cursor)
		if err != nil {
			return nil, err
		}
		if node == nil {
			break
		}
		chain = append(chain, node)
		cursor = node.ParentID
	}

	// Walk root → leaf so children overwrite ancestors.
	entitlements := map[string]any{}
	meta := map[string]any{}
	for i := len(chain) - 1; i >= 0; i-- {
		entitlements = deepMerge(entitlements, chain[i].Entitlements)
		meta = deepMerge(meta, chain[i].Meta)
	}
	entitlements = deepMerge(entitlements, leaf.Entitlements)
	meta = deepMerge(meta, leaf.Meta)

	return &Resolved{
		LicenseTemplate: leaf,
		Entitlements:    entitlements,
		Meta:            meta,
		InheritedDepth:  len(chain),
		Truncated:       truncated,
	}, nil
}

// deepMerge produces a new map with child-wins semantics. Plain-object
// values recurse; arrays and primitives replace wholesale. Inputs are never
// mutated, so callers can use the result alongside the originals safely.
func deepMerge(base, override map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(override))
	maps.Copy(out, base)
	for k, v := range override {
		if existing, ok := out[k]; ok {
			if eMap, eIsMap := existing.(map[string]any); eIsMap {
				if vMap, vIsMap := v.(map[string]any); vIsMap {
					out[k] = deepMerge(eMap, vMap)
					continue
				}
			}
		}
		out[k] = v
	}
	return out
}
