package main

// Newline-delimited JSON file-backed KeyStore for the licensing-keys CLI.
// Mirrors typescript/packages/core/src/cli/json-keystore.ts so a keystore
// file produced by one runtime can be consumed by the other — the wire
// format is `one LicenseKey JSON per line` with a leading sentinel:
//
//	{"__kind":"licensing-keys/v1"}
//	{"id":"...","kid":"...", ...}
//	{"id":"...","kid":"...", ...}
//	...
//
// Mutating ops rewrite atomically via write-to-tmp + rename so a crash
// either preserves the old file or lands the new one whole — never a
// half-written prefix. Directory fsync is best-effort (not all FSes
// support it).

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	lic "github.com/AnoRebel/licensing/licensing"
)

const jsonStoreHeader = `{"__kind":"licensing-keys/v1"}`

// JSONFileKeyStore persists LicenseKey records to an NDJSON file.
// Concurrency: the struct is safe for concurrent use within a single
// process; multi-process contention is not protected (advisory file
// locking could be added if demand arises — the CLI is single-writer by
// design).
type JSONFileKeyStore struct {
	byID   map[string]lic.LicenseKey
	byKid  map[string]string
	path   string
	mu     sync.Mutex
	loaded bool
}

// NewJSONFileKeyStore constructs a JSONFileKeyStore bound to path. The
// file is created on first write.
func NewJSONFileKeyStore(path string) (*JSONFileKeyStore, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	return &JSONFileKeyStore{
		path:  abs,
		byID:  make(map[string]lic.LicenseKey),
		byKid: make(map[string]string),
	}, nil
}

func (s *JSONFileKeyStore) loadIfNeeded() error {
	if s.loaded {
		return nil
	}
	f, err := os.Open(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			s.loaded = true
			return nil
		}
		return err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	// Allow long lines for RSA keys (encrypted PEM can push past 64 KB).
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	first := true
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" {
			continue
		}
		if first {
			if line != jsonStoreHeader {
				return fmt.Errorf("keystore %s: missing or unknown header (expected %s)", s.path, jsonStoreHeader)
			}
			first = false
			continue
		}
		var rec lic.LicenseKey
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			return fmt.Errorf("keystore %s: malformed record: %w", s.path, err)
		}
		s.byID[rec.ID] = rec
		s.byKid[rec.Kid] = rec.ID
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	s.loaded = true
	return nil
}

func (s *JSONFileKeyStore) flush() error {
	// Stable order: by CreatedAt then ID. Keeps diffs review-friendly.
	records := make([]lic.LicenseKey, 0, len(s.byID))
	for _, rec := range s.byID {
		records = append(records, rec)
	}
	sortRecords(records)

	lines := make([]string, 0, len(records)+1)
	lines = append(lines, jsonStoreHeader)
	for _, rec := range records {
		b, err := json.Marshal(rec)
		if err != nil {
			return err
		}
		lines = append(lines, string(b))
	}
	data := strings.Join(lines, "\n") + "\n"

	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(s.path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	// On error, best-effort clean up.
	removeTmp := true
	defer func() {
		if removeTmp {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write([]byte(data)); err != nil {
		tmp.Close()
		return err
	}
	// fsync file for durability.
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, s.path); err != nil {
		return err
	}
	removeTmp = false
	// Best-effort directory fsync (skipped silently if unsupported).
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// sortRecords orders by CreatedAt ascending, then ID ascending. Matches
// the TS emitter so diff-based review produces identical files across
// runtimes.
func sortRecords(in []lic.LicenseKey) {
	// Use a simple insertion sort tolerant of stable order; for n ≲ small
	// operational counts this is fine, and avoids importing sort.
	for i := 1; i < len(in); i++ {
		for j := i; j > 0 && lessRec(in[j], in[j-1]); j-- {
			in[j-1], in[j] = in[j], in[j-1]
		}
	}
}

func lessRec(a, b lic.LicenseKey) bool {
	if a.CreatedAt != b.CreatedAt {
		return a.CreatedAt < b.CreatedAt
	}
	return a.ID < b.ID
}

// KeyStore implementation ------------------------------------------------

func (s *JSONFileKeyStore) Put(rec lic.LicenseKey) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadIfNeeded(); err != nil {
		return err
	}
	if existingID, ok := s.byKid[rec.Kid]; ok && existingID != rec.ID {
		return fmt.Errorf("UniqueConstraintViolation: kid %q already bound to id %s", rec.Kid, existingID)
	}
	s.byID[rec.ID] = rec
	s.byKid[rec.Kid] = rec.ID
	return s.flush()
}

func (s *JSONFileKeyStore) Get(id string) (*lic.LicenseKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadIfNeeded(); err != nil {
		return nil, err
	}
	rec, ok := s.byID[id]
	if !ok {
		return nil, nil
	}
	cp := rec
	return &cp, nil
}

func (s *JSONFileKeyStore) FindByKid(kid string) (*lic.LicenseKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadIfNeeded(); err != nil {
		return nil, err
	}
	id, ok := s.byKid[kid]
	if !ok {
		return nil, nil
	}
	rec := s.byID[id]
	return &rec, nil
}

func (s *JSONFileKeyStore) List(filter lic.KeyStoreFilter) ([]lic.LicenseKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadIfNeeded(); err != nil {
		return nil, err
	}
	out := make([]lic.LicenseKey, 0, len(s.byID))
	for _, rec := range s.byID {
		if filter.ScopeIDSet {
			if !scopeEq(rec.ScopeID, filter.ScopeID) {
				continue
			}
		}
		if filter.Role != nil && rec.Role != *filter.Role {
			continue
		}
		if filter.State != nil && rec.State != *filter.State {
			continue
		}
		if filter.Alg != nil && rec.Alg != *filter.Alg {
			continue
		}
		out = append(out, rec)
	}
	sortRecords(out)
	return out, nil
}

func (s *JSONFileKeyStore) Update(id string, next lic.LicenseKey) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadIfNeeded(); err != nil {
		return err
	}
	if _, ok := s.byID[id]; !ok {
		return fmt.Errorf("TokenMalformed: key not found: %s", id)
	}
	if id != next.ID {
		return fmt.Errorf("TokenMalformed: update cannot change id")
	}
	s.byID[id] = next
	s.byKid[next.Kid] = id
	return s.flush()
}

func scopeEq(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}
