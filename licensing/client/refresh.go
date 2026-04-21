package client

import (
	"errors"
	"fmt"
)

// RefreshOptions configures the refresh call.
type RefreshOptions struct {
	Store              TokenStore
	Path               string
	Transport          TransportOptions
	NowSec             int64
	ProactiveThreshold float64
	GraceWindowSec     int64
	GraceWindowSet     bool
}

func (o RefreshOptions) path() string {
	if o.Path != "" {
		return o.Path
	}
	return "/api/licensing/v1/refresh"
}

func (o RefreshOptions) threshold() float64 {
	if o.ProactiveThreshold > 0 {
		return o.ProactiveThreshold
	}
	return 0.25
}

func (o RefreshOptions) graceWindow() int64 {
	if o.GraceWindowSet {
		return o.GraceWindowSec
	}
	return 604800
}

// RefreshKind is the tagged-union discriminator for RefreshOutcome.
type RefreshKind string

// RefreshKind values. `Refreshed` is the happy path; `NotDue` means the
// token is still fresh and no network call was made; the `Grace*` variants
// report that the issuer was unreachable but the client is still within
// the configured grace window.
const (
	RefreshKindRefreshed      RefreshKind = "refreshed"
	RefreshKindNotDue         RefreshKind = "not-due"
	RefreshKindGraceEntered   RefreshKind = "grace-entered"
	RefreshKindGraceContinued RefreshKind = "grace-continued"
)

// RefreshOutcome is the return type of Refresh.
type RefreshOutcome struct {
	GraceStartSec *int64
	Kind          RefreshKind
	Token         string
}

type refreshRequest struct {
	Token string `json:"token"`
}

type refreshResponse struct {
	Token string `json:"token"`
}

// Refresh proactively refreshes or force-refreshes the stored token.
// Returns a tagged outcome describing what happened.
func Refresh(opts RefreshOptions) (*RefreshOutcome, error) {
	state, err := opts.Store.Read()
	if err != nil {
		return nil, fmt.Errorf("read token store: %w", err)
	}
	if state.Token == "" {
		return nil, NoToken("")
	}

	peek, err := Peek(state.Token)
	if err != nil {
		return nil, err
	}

	graceWindow := opts.graceWindow()

	// If in grace and grace has expired, fail immediately.
	if state.GraceStartSec != nil {
		if graceWindow > 0 && opts.NowSec >= *state.GraceStartSec+graceWindow {
			return nil, GraceExpired("")
		}
	}

	forced := peek.ForceOnlineAfter != nil && opts.NowSec >= *peek.ForceOnlineAfter
	proactive := shouldProactiveRefresh(peek, opts.NowSec, opts.threshold())
	inGrace := state.GraceStartSec != nil

	if !forced && !proactive && !inGrace {
		return &RefreshOutcome{Kind: RefreshKindNotDue, Token: state.Token}, nil
	}

	// Attempt online refresh.
	resp, err := PostJSON[refreshResponse](opts.path(), refreshRequest{
		Token: state.Token,
	}, opts.Transport)

	if err != nil {
		// Only IssuerUnreachable triggers grace logic.
		var ce *ClientError
		if !errors.As(err, &ce) || ce.Code != CodeIssuerUnreachable {
			return nil, err
		}

		// Network failure on forced refresh → enter/continue grace.
		if forced {
			if graceWindow == 0 {
				return nil, RequiresOnlineRefresh("")
			}
			if inGrace {
				return &RefreshOutcome{
					Kind:          RefreshKindGraceContinued,
					Token:         state.Token,
					GraceStartSec: state.GraceStartSec,
				}, nil
			}
			// Enter grace.
			gs := opts.NowSec
			if writeErr := opts.Store.Write(StoredTokenState{
				Token:         state.Token,
				GraceStartSec: &gs,
			}); writeErr != nil {
				return nil, fmt.Errorf("write grace state: %w", writeErr)
			}
			return &RefreshOutcome{
				Kind:          RefreshKindGraceEntered,
				Token:         state.Token,
				GraceStartSec: &gs,
			}, nil
		}

		// Proactive refresh failure → swallow.
		return &RefreshOutcome{Kind: RefreshKindNotDue, Token: state.Token}, nil
	}

	// Success — clear grace.
	if err := opts.Store.Write(StoredTokenState{Token: resp.Token}); err != nil {
		return nil, fmt.Errorf("write refreshed token: %w", err)
	}
	return &RefreshOutcome{Kind: RefreshKindRefreshed, Token: resp.Token}, nil
}

func shouldProactiveRefresh(peek *PeekResult, nowSec int64, threshold float64) bool {
	lifetime := peek.Exp - peek.Nbf
	if lifetime <= 0 {
		return true
	}
	remaining := peek.Exp - nowSec
	if remaining <= 0 {
		return true
	}
	return float64(remaining)/float64(lifetime) < threshold
}
