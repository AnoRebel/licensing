package client

import (
	"context"
	"sync"
	"time"
)

// HeartbeatOptions configures the heartbeat sender.
type HeartbeatOptions struct {
	Store          TokenStore
	OnError        func(error)
	OnSuccess      func()
	NowFunc        func() int64
	LicenseKey     string
	Fingerprint    string
	RuntimeVersion string
	Path           string
	Transport      TransportOptions
	IntervalSec    int
}

func (o HeartbeatOptions) path() string {
	if o.Path != "" {
		return o.Path
	}
	return "/api/licensing/v1/heartbeat"
}

func (o HeartbeatOptions) interval() time.Duration {
	sec := o.IntervalSec
	if sec < 60 {
		sec = 3600
	}
	return time.Duration(sec) * time.Second
}

func (o HeartbeatOptions) now() int64 {
	if o.NowFunc != nil {
		return o.NowFunc()
	}
	return time.Now().Unix()
}

// Heartbeat sends periodic liveness signals to the issuer.
type Heartbeat struct {
	cancel  context.CancelFunc
	opts    HeartbeatOptions
	mu      sync.Mutex
	running bool
}

// NewHeartbeat creates a Heartbeat. Call Start to begin ticking.
func NewHeartbeat(opts HeartbeatOptions) *Heartbeat {
	return &Heartbeat{opts: opts}
}

// Start begins the background ticker. Idempotent.
func (h *Heartbeat) Start() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.running {
		return
	}
	h.running = true
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	go h.loop(ctx)
}

// Stop cancels the background ticker. Idempotent.
func (h *Heartbeat) Stop() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.running {
		return
	}
	h.running = false
	h.cancel()
}

// TickNow fires a single heartbeat immediately.
func (h *Heartbeat) TickNow() {
	h.tick()
}

func (h *Heartbeat) loop(ctx context.Context) {
	ticker := time.NewTicker(h.opts.interval())
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.tick()
		}
	}
}

type heartbeatRequest struct {
	LicenseKey     string `json:"license_key"`
	Fingerprint    string `json:"fingerprint"`
	RuntimeVersion string `json:"runtime_version"`
	Timestamp      int64  `json:"timestamp"`
}

type heartbeatResponse struct{}

func (h *Heartbeat) tick() {
	ok := SendOneHeartbeat(h.opts)
	_ = ok
}

// SendOneHeartbeat fires a single heartbeat. Returns true on success.
func SendOneHeartbeat(opts HeartbeatOptions) bool {
	_, err := PostJSON[heartbeatResponse](opts.path(), heartbeatRequest{
		LicenseKey:     opts.LicenseKey,
		Fingerprint:    opts.Fingerprint,
		RuntimeVersion: opts.RuntimeVersion,
		Timestamp:      opts.now(),
	}, opts.Transport)
	if err != nil {
		if opts.OnError != nil {
			opts.OnError(err)
		}
		return false
	}

	// On success, clear graceStartSec if present.
	if opts.Store != nil {
		state, readErr := opts.Store.Read()
		if readErr != nil {
			if opts.OnError != nil {
				opts.OnError(readErr)
			}
		} else if state.GraceStartSec != nil {
			if writeErr := opts.Store.Write(StoredTokenState{Token: state.Token}); writeErr != nil && opts.OnError != nil {
				opts.OnError(writeErr)
			}
		}
	}

	if opts.OnSuccess != nil {
		opts.OnSuccess()
	}
	return true
}
