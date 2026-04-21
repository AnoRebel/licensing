package client

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// StoredTokenState is the shape persisted by TokenStore implementations.
type StoredTokenState struct {
	GraceStartSec *int64 `json:"graceStartSec"`
	Token         string `json:"token"`
}

// EmptyState returns a zero-value state (no token, no grace).
func EmptyState() StoredTokenState {
	return StoredTokenState{}
}

// TokenStore is the pluggable persistence interface for the client's
// current token and grace-start timestamp.
type TokenStore interface {
	Read() (StoredTokenState, error)
	Write(state StoredTokenState) error
	Clear() error
}

// ---------- MemoryTokenStore ----------

// MemoryTokenStore is an in-memory TokenStore suitable for tests.
type MemoryTokenStore struct {
	state StoredTokenState
	mu    sync.Mutex
}

// NewMemoryTokenStore constructs a new memory token store.
func NewMemoryTokenStore() *MemoryTokenStore {
	return &MemoryTokenStore{}
}

func (m *MemoryTokenStore) Read() (StoredTokenState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state, nil
}

func (m *MemoryTokenStore) Write(state StoredTokenState) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state = state
	return nil
}

// Clear resets the in-memory state to empty. Safe for concurrent use.
func (m *MemoryTokenStore) Clear() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state = EmptyState()
	return nil
}

// ---------- FileTokenStore ----------

// FileTokenStore persists token state to a JSON file. Atomic writes via
// tmp+rename. Creates parent directories on write. Mode 0600.
type FileTokenStore struct {
	path string
}

// NewFileTokenStore constructs a new file token store.
func NewFileTokenStore(path string) *FileTokenStore {
	return &FileTokenStore{path: path}
}

func (f *FileTokenStore) Read() (StoredTokenState, error) {
	data, err := os.ReadFile(f.path)
	if err != nil {
		if os.IsNotExist(err) {
			return EmptyState(), nil
		}
		return EmptyState(), err
	}
	var state StoredTokenState
	if err := json.Unmarshal(data, &state); err != nil {
		// Surface the error. Silently degrading to empty state hides
		// tampering and forces a re-activate (seat spend). Callers decide
		// whether to Clear() and re-activate or surface to the user.
		return EmptyState(), fmt.Errorf("token store file is corrupt: %w", err)
	}
	return state, nil
}

func (f *FileTokenStore) Write(state StoredTokenState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	dir := filepath.Dir(f.path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	// Atomic + durable: write to tmp, fsync file, rename, fsync dir.
	tmp := f.path + ".tmp"
	tf, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	if _, err := tf.Write(data); err != nil {
		_ = tf.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := tf.Sync(); err != nil {
		_ = tf.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := tf.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, f.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	// Best-effort fsync of the directory to persist the rename.
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// Clear deletes the backing file; a missing file is treated as success.
func (f *FileTokenStore) Clear() error {
	err := os.Remove(f.path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
