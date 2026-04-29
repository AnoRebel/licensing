package templates_test

import (
	"context"
	"reflect"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/templates"
)

func tmpl(id string, parentID *string, ent map[string]any) *lic.LicenseTemplate {
	if ent == nil {
		ent = map[string]any{}
	}
	return &lic.LicenseTemplate{
		ID:           id,
		ParentID:     parentID,
		Name:         id,
		MaxUsages:    5,
		Entitlements: ent,
		Meta:         map[string]any{},
		CreatedAt:    "2026-01-01T00:00:00.000000Z",
		UpdatedAt:    "2026-01-01T00:00:00.000000Z",
	}
}

func loaderFor(rows ...*lic.LicenseTemplate) templates.Loader {
	byID := make(map[string]*lic.LicenseTemplate, len(rows))
	for _, r := range rows {
		byID[r.ID] = r
	}
	return func(_ context.Context, id string) (*lic.LicenseTemplate, error) {
		return byID[id], nil
	}
}

func ptr(s string) *string { return &s }

func TestResolve_Flat(t *testing.T) {
	a := tmpl("a", nil, map[string]any{"tier": "basic", "seats": 5})
	got, err := templates.Resolve(context.Background(), a, loaderFor(a), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Entitlements, map[string]any{"tier": "basic", "seats": 5}) {
		t.Fatalf("entitlements: %v", got.Entitlements)
	}
	if got.InheritedDepth != 0 {
		t.Fatalf("depth: want 0, got %d", got.InheritedDepth)
	}
}

func TestResolve_OneLevel(t *testing.T) {
	a := tmpl("a", nil, map[string]any{"tier": "basic", "seats": 5})
	b := tmpl("b", ptr("a"), map[string]any{"tier": "pro"})
	got, err := templates.Resolve(context.Background(), b, loaderFor(a, b), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Entitlements, map[string]any{"tier": "pro", "seats": 5}) {
		t.Fatalf("entitlements: %v", got.Entitlements)
	}
}

func TestResolve_ThreeLevel(t *testing.T) {
	a := tmpl("a", nil, map[string]any{"tier": "basic", "seats": 5})
	b := tmpl("b", ptr("a"), map[string]any{"tier": "pro"})
	c := tmpl("c", ptr("b"), map[string]any{"sso": true})
	got, err := templates.Resolve(context.Background(), c, loaderFor(a, b, c), nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"tier": "pro", "seats": 5, "sso": true}
	if !reflect.DeepEqual(got.Entitlements, want) {
		t.Fatalf("got %v want %v", got.Entitlements, want)
	}
}

func TestResolve_NestedDeepMerge(t *testing.T) {
	a := tmpl("a", nil, map[string]any{"features": map[string]any{"sso": false, "audit": true}})
	b := tmpl("b", ptr("a"), map[string]any{"features": map[string]any{"sso": true}})
	got, err := templates.Resolve(context.Background(), b, loaderFor(a, b), nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"features": map[string]any{"sso": true, "audit": true}}
	if !reflect.DeepEqual(got.Entitlements, want) {
		t.Fatalf("got %v want %v", got.Entitlements, want)
	}
}

func TestResolve_DepthCap(t *testing.T) {
	rows := make([]*lic.LicenseTemplate, 0, 10)
	var prev *string
	for i := range 8 {
		id := "n" + string(rune('0'+i))
		rows = append(rows, tmpl(id, prev, map[string]any{"level": i}))
		copyID := id
		prev = &copyID
	}
	leaf := tmpl("leaf", prev, map[string]any{"is_leaf": true})
	rows = append(rows, leaf)
	got, err := templates.Resolve(context.Background(), leaf, loaderFor(rows...), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Truncated {
		t.Fatal("expected truncated=true")
	}
	if got.InheritedDepth != templates.MaxDepth {
		t.Fatalf("depth: want %d, got %d", templates.MaxDepth, got.InheritedDepth)
	}
}

func TestResolve_Cycle_HaltsGracefully(t *testing.T) {
	a := tmpl("a", ptr("b"), map[string]any{"tag": "a"})
	b := tmpl("b", ptr("a"), map[string]any{"tag": "b"})
	got, err := templates.Resolve(context.Background(), a, loaderFor(a, b), nil)
	if err != nil {
		t.Fatal(err)
	}
	// Leaf's tag still wins.
	if got.Entitlements["tag"] != "a" {
		t.Fatalf("expected leaf tag a, got %v", got.Entitlements["tag"])
	}
}
