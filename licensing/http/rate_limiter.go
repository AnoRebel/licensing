package http

import (
	"container/list"
	"math"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	lic "github.com/AnoRebel/licensing/licensing"
)

// maxRetryAfterSec caps the Retry-After advice so a pathological RefillRate
// configuration (e.g. 0.0001 req/s) cannot emit an absurd wait like 10000s.
// Real rate-limit waits should resolve inside a few minutes at most; an
// operator intending longer lockouts should use a proper ban system.
const maxRetryAfterSec = 3600

// TimeSource abstracts wall-clock access for the rate limiter. It is
// deliberately separate from lic.Clock (which returns ISO strings for
// token timestamps) because the bucket math needs monotonic time.Time.
// Production uses SystemTimeSource; tests inject a FakeTimeSource for
// deterministic scheduling.
type TimeSource interface {
	Now() time.Time
}

// SystemTimeSource returns time.Now() on every call. Zero value is usable.
type SystemTimeSource struct{}

// Now returns the current wall-clock time in UTC.
func (SystemTimeSource) Now() time.Time { return time.Now() }

// RateLimitConfig tunes the token-bucket rate limiter. Zero values fall
// back to sensible defaults so callers can construct with just a Clock.
//
// Intuition:
//   - Capacity   = burst size (how many requests a fresh key can fire back to back)
//   - RefillRate = sustained throughput in requests/second (tokens added per second)
//   - KeyFunc    = how to bucket callers; default is RemoteAddrKeyFunc
//
// A denied request gets a 429 with a Retry-After header computed from how
// long the caller has to wait to accrue one full token. The retry hint is
// rounded up to the nearest whole second because RFC 7231 / RFC 9110
// restrict Retry-After to integer seconds (or an HTTP-date), and capped at
// maxRetryAfterSec so a misconfigured refill rate can't emit absurd waits.
type RateLimitConfig struct {
	Clock      TimeSource
	KeyFunc    func(r *http.Request) string
	Capacity   float64
	RefillRate float64
	MaxKeys    int
	IdleTTL    time.Duration
}

func (c *RateLimitConfig) capacity() float64 {
	if c.Capacity > 0 {
		return c.Capacity
	}
	return 30
}

func (c *RateLimitConfig) refill() float64 {
	if c.RefillRate > 0 {
		return c.RefillRate
	}
	return 10
}

func (c *RateLimitConfig) maxKeys() int {
	if c.MaxKeys > 0 {
		return c.MaxKeys
	}
	return 10_000
}

func (c *RateLimitConfig) idleTTL() time.Duration {
	if c.IdleTTL > 0 {
		return c.IdleTTL
	}
	// Derived default: ten full refill windows, minimum 5 minutes.
	ttl := time.Duration(10*c.capacity()/c.refill()) * time.Second
	if ttl < 5*time.Minute {
		ttl = 5 * time.Minute
	}
	return ttl
}

// RateLimiter is the runtime state for a token-bucket limiter. Construct
// with NewRateLimiter; mount with Middleware. Safe for concurrent use.
//
// Buckets are tracked in a doubly-linked list keyed by their map entry so
// LRU eviction and idle-sweep are O(1) per operation; a linear scan would
// let an attacker create 10k unique keys and make each request pay O(N)
// under the lock.
type RateLimiter struct {
	lastSwep time.Time
	buckets  map[string]*bucket
	lru      *list.List
	cfg      RateLimitConfig
	mu       sync.Mutex
}

type bucket struct {
	lastTick time.Time
	elem     *list.Element
	key      string
	tokens   float64
}

// NewRateLimiter builds a limiter from cfg. A zero Clock falls back to
// SystemTimeSource so real-time wall clock is used by default; tests
// inject their own TimeSource to make timing deterministic. Non-finite
// or negative Capacity/RefillRate values panic at construction — a
// misconfigured limiter is a deploy-time bug, not a runtime surprise.
//
// Note on KeyFunc: the default is RemoteAddrKeyFunc, which keys on the
// raw r.RemoteAddr (the direct peer). If the issuer sits behind a
// trusted proxy, use TrustedProxyKeyFunc to opt into X-Forwarded-For /
// X-Real-IP parsing — unconditionally trusting those headers lets any
// untrusted client spoof arbitrary keys and defeat the limiter.
func NewRateLimiter(cfg RateLimitConfig) *RateLimiter {
	if cfg.Clock == nil {
		cfg.Clock = SystemTimeSource{}
	}
	if cfg.KeyFunc == nil {
		cfg.KeyFunc = RemoteAddrKeyFunc
	}
	if c := cfg.Capacity; c < 0 || math.IsNaN(c) || math.IsInf(c, 0) {
		panic("http.NewRateLimiter: Capacity must be a finite, non-negative number")
	}
	if r := cfg.RefillRate; r < 0 || math.IsNaN(r) || math.IsInf(r, 0) {
		panic("http.NewRateLimiter: RefillRate must be a finite, non-negative number")
	}
	return &RateLimiter{
		cfg:     cfg,
		buckets: make(map[string]*bucket),
		lru:     list.New(),
	}
}

// Middleware wraps next so each incoming request is metered against the
// bucket keyed by cfg.KeyFunc. On allow, next.ServeHTTP runs; on deny, a
// 429 envelope is written with Retry-After set to the ceiling of the wait
// time in seconds.
//
// The limiter is process-local. For horizontally-scaled deployments,
// callers should plug in a distributed rate limiter (Redis, etc.); this
// reference implementation is intended for single-node setups and tests.
func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	if next == nil {
		panic("http.RateLimiter.Middleware: next is nil")
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := rl.cfg.KeyFunc(r)
		if key == "" {
			// Key resolution failed — let the request through rather than
			// fail-closed on an unknowable caller. Operators can plug in a
			// stricter KeyFunc if they want fail-closed.
			next.ServeHTTP(w, r)
			return
		}
		allowed, retryAfterSec := rl.take(key)
		if !allowed {
			retryHdr := strconv.Itoa(retryAfterSec)
			writeErrorWithHeaders(w, http.StatusTooManyRequests,
				string(lic.CodeRateLimited),
				"rate limit exceeded",
				map[string]string{"Retry-After": retryHdr},
			)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// take attempts to remove one token from the bucket identified by key.
// Returns (allowed, retryAfterSec). When allowed is true, retryAfterSec is
// always 0. When false, retryAfterSec is the ceiling (in whole seconds) of
// the time the caller must wait before a fresh token is available, capped
// at maxRetryAfterSec so a pathological refill rate cannot leak an absurd
// integer into the Retry-After header.
func (rl *RateLimiter) take(key string) (bool, int) {
	now := rl.cfg.Clock.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()

	// Opportunistic idle sweep — bounded to once per idleTTL so the amortised
	// cost per take() stays O(1). A background goroutine would be cleaner but
	// would tangle shutdown semantics for a library; piggybacking is simpler.
	rl.maybeSweepLocked(now)

	b, ok := rl.buckets[key]
	if !ok {
		// New bucket starts full so a fresh caller isn't penalized for the
		// first request. Enforce the key cap before inserting.
		if maxKeys := rl.cfg.maxKeys(); len(rl.buckets) >= maxKeys {
			rl.evictLRULocked()
		}
		b = &bucket{key: key, tokens: rl.cfg.capacity(), lastTick: now}
		b.elem = rl.lru.PushFront(b)
		rl.buckets[key] = b
	} else {
		elapsed := now.Sub(b.lastTick).Seconds()
		if elapsed > 0 {
			b.tokens = math.Min(rl.cfg.capacity(), b.tokens+elapsed*rl.cfg.refill())
			b.lastTick = now
		}
		rl.lru.MoveToFront(b.elem)
	}

	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	// Not enough tokens. Time to wait for one full token:
	deficit := 1 - b.tokens
	wait := deficit / rl.cfg.refill()
	retryAfter := int(math.Ceil(wait))
	if retryAfter < 1 {
		retryAfter = 1
	}
	if retryAfter > maxRetryAfterSec {
		retryAfter = maxRetryAfterSec
	}
	return false, retryAfter
}

// evictLRULocked drops the least-recently-used bucket. Called with rl.mu
// held. O(1) — the LRU list's Back() points directly at the stalest entry.
func (rl *RateLimiter) evictLRULocked() {
	back := rl.lru.Back()
	if back == nil {
		return
	}
	b := back.Value.(*bucket)
	rl.lru.Remove(back)
	delete(rl.buckets, b.key)
}

// maybeSweepLocked walks the LRU from the back, removing buckets whose last
// tick is older than idleTTL. Bounded to one pass per idleTTL interval so
// the amortised per-request cost stays O(1). Called with rl.mu held.
func (rl *RateLimiter) maybeSweepLocked(now time.Time) {
	ttl := rl.cfg.idleTTL()
	if !rl.lastSwep.IsZero() && now.Sub(rl.lastSwep) < ttl {
		return
	}
	rl.lastSwep = now
	cutoff := now.Add(-ttl)
	for {
		back := rl.lru.Back()
		if back == nil {
			return
		}
		b := back.Value.(*bucket)
		if !b.lastTick.Before(cutoff) {
			return
		}
		rl.lru.Remove(back)
		delete(rl.buckets, b.key)
	}
}

// RemoteAddrKeyFunc derives a rate-limit key from r.RemoteAddr only. This
// is the safe default: it ignores forwarded-for headers, which any client
// can set to whatever they want. Use this when the issuer is fronted by
// no proxy, or when the proxy strips untrusted forwarding headers.
func RemoteAddrKeyFunc(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// TrustedProxyKeyFunc returns a KeyFunc that reads X-Forwarded-For only
// when r.RemoteAddr falls inside one of the trusted prefixes. The first
// entry of XFF is taken as the client per RFC 7239, falling back to
// X-Real-IP and then RemoteAddr. Requests from untrusted peers are keyed
// purely by RemoteAddr, so a client cannot spoof its rate-limit bucket
// by forging headers.
//
// Prefixes use netip.ParsePrefix strings (e.g. "10.0.0.0/8", "::1/128").
// Callers who want to trust a single address can pass /32 or /128.
//
// Panics if trusted is empty — a "trusted proxy" key func without any
// trusted proxies is a misconfiguration, and falling silently back to
// RemoteAddr would mask the mistake.
func TrustedProxyKeyFunc(trusted []netip.Prefix) func(*http.Request) string {
	if len(trusted) == 0 {
		panic("http.TrustedProxyKeyFunc: trusted is empty; use RemoteAddrKeyFunc instead")
	}
	// Copy so callers can't mutate the slice out from under us.
	prefixes := make([]netip.Prefix, len(trusted))
	copy(prefixes, trusted)
	return func(r *http.Request) string {
		peer := remoteHost(r.RemoteAddr)
		if peer == "" {
			return r.RemoteAddr
		}
		peerAddr, err := netip.ParseAddr(peer)
		if err != nil {
			return peer
		}
		trusted := false
		for _, p := range prefixes {
			if p.Contains(peerAddr) {
				trusted = true
				break
			}
		}
		if !trusted {
			return peer
		}
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if comma := strings.IndexByte(xff, ','); comma > 0 {
				return strings.TrimSpace(xff[:comma])
			}
			return strings.TrimSpace(xff)
		}
		if xri := r.Header.Get("X-Real-IP"); xri != "" {
			return strings.TrimSpace(xri)
		}
		return peer
	}
}

func remoteHost(remoteAddr string) string {
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		return host
	}
	return remoteAddr
}
