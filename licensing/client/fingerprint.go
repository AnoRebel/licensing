package client

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"runtime"
	"sort"
	"strings"
)

// FingerprintSource is a pluggable source of device identity strings.
// Collect returns "" when the source is unavailable on this platform.
type FingerprintSource interface {
	Name() string
	Collect() (string, error)
}

// FingerprintFromSources is a pure function: sort, join with newlines,
// SHA-256, return lowercase hex. Inputs must be non-empty and contain no
// newlines.
func FingerprintFromSources(sources []string) (string, error) {
	if len(sources) == 0 {
		return "", fmt.Errorf("fingerprint requires at least one source")
	}
	for _, s := range sources {
		if s == "" {
			return "", fmt.Errorf("fingerprint source must not be empty")
		}
		if strings.ContainsRune(s, '\n') {
			return "", fmt.Errorf("fingerprint source must not contain newlines")
		}
	}
	sorted := make([]string, len(sources))
	copy(sorted, sources)
	sort.Strings(sorted)
	joined := strings.Join(sorted, "\n")
	h := sha256.Sum256([]byte(joined))
	return hex.EncodeToString(h[:]), nil
}

// CollectFingerprint runs all sources, filters empty results, and hashes.
func CollectFingerprint(sources []FingerprintSource) (string, error) {
	var vals []string
	for _, src := range sources {
		v, err := src.Collect()
		if err != nil {
			return "", fmt.Errorf("fingerprint source %s: %w", src.Name(), err)
		}
		if v != "" {
			vals = append(vals, v)
		}
	}
	if len(vals) == 0 {
		return "", fmt.Errorf("all fingerprint sources returned empty")
	}
	return FingerprintFromSources(vals)
}

// DefaultFingerprintSources returns the standard set of sources matching
// the TS implementation: OS info, machine ID, primary MAC, and app salt.
func DefaultFingerprintSources(appSalt string) []FingerprintSource {
	if appSalt == "" {
		panic("DefaultFingerprintSources: appSalt must not be empty")
	}
	return []FingerprintSource{
		osSource{},
		machineIDSource{},
		primaryMACSource{},
		saltSource{salt: appSalt},
	}
}

// ---------- built-in sources ----------

type osSource struct{}

// Name returns the fingerprint source identifier.
func (osSource) Name() string { return "os.id" }

// Collect returns a `os:<goos>:<goarch>` string derived from runtime build tags.
func (osSource) Collect() (string, error) {
	return fmt.Sprintf("os:%s:%s", runtime.GOOS, runtime.GOARCH), nil
}

type machineIDSource struct{}

// Name returns the fingerprint source identifier.
func (machineIDSource) Name() string { return "machine.id" }

// Collect reads /etc/machine-id (or dbus fallback) and returns a `machine:<id>` string.
// Returns "" when no machine-id file is readable (e.g., non-Linux).
func (machineIDSource) Collect() (string, error) {
	for _, path := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		id := strings.TrimSpace(string(data))
		if id != "" {
			return "machine:" + id, nil
		}
	}
	return "", nil // unavailable on this platform
}

type primaryMACSource struct{}

// Name returns the fingerprint source identifier.
func (primaryMACSource) Name() string { return "net.primaryMac" }

// Collect returns a `mac:<iface>|<hwaddr>` string for the lexicographically
// first non-loopback interface with a non-zero MAC. Returns "" when no usable
// interface is present.
func (primaryMACSource) Collect() (string, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", nil
	}
	type entry struct {
		name string
		mac  string
	}
	var candidates []entry
	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		mac := iface.HardwareAddr.String()
		if mac == "" || mac == "00:00:00:00:00:00" {
			continue
		}
		candidates = append(candidates, entry{name: iface.Name, mac: mac})
	}
	if len(candidates) == 0 {
		return "", nil
	}
	// Pick lexicographically first by interface name (matches TS behavior).
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].name < candidates[j].name
	})
	c := candidates[0]
	return fmt.Sprintf("mac:%s|%s", c.name, c.mac), nil
}

type saltSource struct {
	salt string
}

// Name returns the fingerprint source identifier.
func (s saltSource) Name() string { return "app.salt" }

// Collect returns the caller-provided app salt prefixed with "salt:" so it
// participates in the fingerprint but stays distinguishable from OS inputs.
func (s saltSource) Collect() (string, error) {
	return "salt:" + s.salt, nil
}
