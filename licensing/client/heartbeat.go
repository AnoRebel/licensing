package client

import (
	"context"
	"errors"
	"sync"
	"time"
)

// HeartbeatOptions configures the heartbeat sender.
//
// The request body sent to /heartbeat is just `{token}` — the server
// derives license_id, usage_id, fingerprint, etc. from the verified
// token's claims. Earlier shapes carried license_key / fingerprint /
// runtime_version / timestamp fields that were never read by the
// server; they were removed in this version.
type HeartbeatOptions struct {
	Store       TokenStore
	OnError     func(error)
	OnSuccess   func()
	Path        string
	Transport   TransportOptions
	IntervalSec int
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

// heartbeatRequest matches the server-side handler at
// licensing/http/client_handlers.go::handleHeartbeat. The server
// extracts license_id, usage_id, status, etc. from the token claims —
// no extra fields are needed. (license_key / fingerprint / runtime_version
// / timestamp were sent in v0.0.x but the server never read them and the
// mismatch caused 400 BadRequest in production.)
type heartbeatRequest struct {
	Token string `json:"token"`
}

type heartbeatResponse struct{}

func (h *Heartbeat) tick() {
	SendOneHeartbeat(h.opts)
}

// SendOneHeartbeat fires a single heartbeat. Returns true on success.
//
// Behaviour on the typed-error response shape:
//
//   - LicenseRevoked / LicenseSuspended: the issuer's authoritative view
//     says the local token is no longer valid. Clear the store (best-
//     effort, with a CAS-style check so a parallel Refresh that already
//     wrote a fresh token isn't clobbered) and surface the error via
//     OnError so the application can prompt the user to re-activate.
//   - IssuerUnreachable / RateLimited / other transport errors: leave the
//     store alone; the next refresh's grace logic handles real outages.
//   - Successful 200: clear any grace marker, fire OnSuccess.
func SendOneHeartbeat(opts HeartbeatOptions) bool {
	if opts.Store == nil {
		// Heartbeat without a store has nothing to send (and nothing to
		// react to revocation against). Treat as a no-op.
		return true
	}
	state, readErr := opts.Store.Read()
	if readErr != nil {
		if opts.OnError != nil {
			opts.OnError(readErr)
		}
		return false
	}
	if state.Token == "" {
		// No token to heartbeat with. Skip silently — the application
		// hasn't activated yet.
		return true
	}

	_, err := PostJSON[heartbeatResponse](opts.path(), heartbeatRequest{
		Token: state.Token,
	}, opts.Transport)
	if err != nil {
		// Typed-error reaction: revoked / suspended → clear local store
		// (CAS so a concurrent Refresh isn't clobbered).
		var ce *ClientError
		if errors.As(err, &ce) {
			if ce.Code == CodeLicenseRevoked || ce.Code == CodeLicenseSuspended {
				if cur, readErr2 := opts.Store.Read(); readErr2 == nil && cur.Token == state.Token {
					if clearErr := opts.Store.Clear(); clearErr != nil && opts.OnError != nil {
						opts.OnError(clearErr)
					}
				}
			}
		}
		if opts.OnError != nil {
			opts.OnError(err)
		}
		return false
	}

	// On success, clear graceStartSec if present.
	if state.GraceStartSec != nil {
		if writeErr := opts.Store.Write(StoredTokenState{Token: state.Token}); writeErr != nil && opts.OnError != nil {
			opts.OnError(writeErr)
		}
	}

	if opts.OnSuccess != nil {
		opts.OnSuccess()
	}
	return true
}
