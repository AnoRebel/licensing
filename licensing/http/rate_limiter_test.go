package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeTimeSource is a deterministic TimeSource for rate-limiter tests.
// Advance() moves the clock forward; concurrent use is supported.
type fakeTimeSource struct {
	now time.Time
	mu  sync.Mutex
}

func newFakeTime(seed time.Time) *fakeTimeSource {
	return &fakeTimeSource{now: seed}
}

func (f *fakeTimeSource) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *fakeTimeSource) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d)
}

func newCounter() (http.Handler, *int32) {
	var n int32
	h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&n, 1)
		w.WriteHeader(http.StatusOK)
	})
	return h, &n
}

func requestFromIP(ip string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/admin/licenses", nil)
	req.RemoteAddr = ip + ":54321"
	return req
}

func TestRateLimiter_AllowsBurstThen429(t *testing.T) {
	// Capacity=3, refill=1/sec. 3 rapid requests should pass, 4th should 429.
	clk := newFakeTime(time.Unix(1_700_000_000, 0))
	rl := NewRateLimiter(RateLimitConfig{Capacity: 3, RefillRate: 1, Clock: clk})
	next, hits := newCounter()
	h := rl.Middleware(next)

	for i := 0; i < 3; i++ {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, requestFromIP("1.1.1.1"))
		if rr.Code != http.StatusOK {
			t.Fatalf("burst req %d: want 200, got %d", i, rr.Code)
		}
	}
	if got := atomic.LoadInt32(hits); got != 3 {
		t.Fatalf("want 3 passthroughs, got %d", got)
	}

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, requestFromIP("1.1.1.1"))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("want 429, got %d", rr.Code)
	}
	ra := rr.Header().Get("Retry-After")
	if ra == "" {
		t.Fatal("missing Retry-After header")
	}
	if _, err := strconv.Atoi(ra); err != nil {
		t.Fatalf("Retry-After not integer: %q (%v)", ra, err)
	}
	var env Envelope
	if err := json.NewDecoder(rr.Body).Decode(&env); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if env.Success || env.Error == nil || env.Error.Code != "RateLimited" {
		t.Fatalf("unexpected envelope: %+v", env)
	}
}

func TestRateLimiter_RefillsOverTime(t *testing.T) {
	clk := newFakeTime(time.Unix(1_700_000_000, 0))
	rl := NewRateLimiter(RateLimitConfig{Capacity: 1, RefillRate: 2, Clock: clk})
	next, _ := newCounter()
	h := rl.Middleware(next)

	// First request consumes the single token.
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, requestFromIP("2.2.2.2"))
	if rr.Code != http.StatusOK {
		t.Fatalf("first: want 200, got %d", rr.Code)
	}

	// Immediately retry — should be denied.
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, requestFromIP("2.2.2.2"))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("second: want 429, got %d", rr.Code)
	}

	// Advance past refill of one token (0.5s @ 2/sec).
	clk.Advance(600 * time.Millisecond)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, requestFromIP("2.2.2.2"))
	if rr.Code != http.StatusOK {
		t.Fatalf("after refill: want 200, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestRateLimiter_PerKeyIsolation(t *testing.T) {
	// Two distinct IPs should each get their own bucket.
	clk := newFakeTime(time.Unix(1_700_000_000, 0))
	rl := NewRateLimiter(RateLimitConfig{Capacity: 1, RefillRate: 0.01, Clock: clk})
	next, _ := newCounter()
	h := rl.Middleware(next)

	for _, ip := range []string{"1.1.1.1", "2.2.2.2"} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, requestFromIP(ip))
		if rr.Code != http.StatusOK {
			t.Fatalf("%s: want 200, got %d", ip, rr.Code)
		}
	}
	// Each IP's second request should 429 (tokens exhausted independently).
	for _, ip := range []string{"1.1.1.1", "2.2.2.2"} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, requestFromIP(ip))
		if rr.Code != http.StatusTooManyRequests {
			t.Fatalf("%s second: want 429, got %d", ip, rr.Code)
		}
	}
}

func TestRateLimiter_RetryAfterReflectsWait(t *testing.T) {
	// Capacity=1, refill=0.1/sec → deficit of 1 token takes 10s; Retry-After ≥ 10.
	clk := newFakeTime(time.Unix(1_700_000_000, 0))
	rl := NewRateLimiter(RateLimitConfig{Capacity: 1, RefillRate: 0.1, Clock: clk})
	next, _ := newCounter()
	h := rl.Middleware(next)

	// Use up the one token.
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, requestFromIP("3.3.3.3"))
	if rr.Code != http.StatusOK {
		t.Fatalf("setup: want 200, got %d", rr.Code)
	}

	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, requestFromIP("3.3.3.3"))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("want 429, got %d", rr.Code)
	}
	ra, err := strconv.Atoi(rr.Header().Get("Retry-After"))
	if err != nil {
		t.Fatalf("Retry-After parse: %v", err)
	}
	if ra < 10 {
		t.Fatalf("Retry-After=%d, want >= 10", ra)
	}
}

func TestRateLimiter_DefaultKeyFuncIgnoresXFF(t *testing.T) {
	// Under the safe default (RemoteAddrKeyFunc), a forged X-Forwarded-For
	// header must NOT be honoured — otherwise any client could spoof its
	// bucket by rotating the header.
	clk := newFakeTime(time.Unix(1_700_000_000, 0))
	rl := NewRateLimiter(RateLimitConfig{Capacity: 1, RefillRate: 0.01, Clock: clk})
	next, _ := newCounter()
	h := rl.Middleware(next)

	for i, xff := range []string{"10.0.0.1, 172.16.0.1", "10.0.0.2, 172.16.0.1"} {
		req := httptest.NewRequest(http.MethodGet, "/admin", nil)
		req.RemoteAddr = "192.168.1.1:54321"
		req.Header.Set("X-Forwarded-For", xff)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		want := http.StatusOK
		if i == 1 {
			// Second request from same RemoteAddr is throttled regardless of XFF.
			want = http.StatusTooManyRequests
		}
		if rr.Code != want {
			t.Fatalf("req %d xff=%q: want %d, got %d", i, xff, want, rr.Code)
		}
	}
}

func TestRateLimiter_TrustedProxyKeyFunc_HonoursXFF(t *testing.T) {
	// When the peer is in the trusted prefix set, XFF's first entry is used.
	clk := newFakeTime(time.Unix(1_700_000_000, 0))
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	rl := NewRateLimiter(RateLimitConfig{
		Capacity:   1,
		RefillRate: 0.01,
		Clock:      clk,
		KeyFunc:    TrustedProxyKeyFunc(trusted),
	})
	next, _ := newCounter()
	h := rl.Middleware(next)

	// Two distinct client IPs behind the trusted proxy → two buckets.
	for _, xff := range []string{"203.0.113.1, 172.16.0.1", "203.0.113.2"} {
		req := httptest.NewRequest(http.MethodGet, "/admin", nil)
		req.RemoteAddr = "10.1.2.3:54321"
		req.Header.Set("X-Forwarded-For", xff)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("%s: want 200, got %d", xff, rr.Code)
		}
	}
	// Reusing the first client IP should now 429.
	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	req.RemoteAddr = "10.1.2.3:54321"
	req.Header.Set("X-Forwarded-For", "203.0.113.1, 172.16.0.1")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("want 429 for reused client IP, got %d", rr.Code)
	}
}

func TestRateLimiter_TrustedProxyKeyFunc_UntrustedPeerIgnoresXFF(t *testing.T) {
	// If the peer is outside the trusted set, XFF MUST be ignored even when
	// using TrustedProxyKeyFunc — otherwise a direct attacker could set XFF
	// to bypass their own IP bucket.
	clk := newFakeTime(time.Unix(1_700_000_000, 0))
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	rl := NewRateLimiter(RateLimitConfig{
		Capacity:   1,
		RefillRate: 0.01,
		Clock:      clk,
		KeyFunc:    TrustedProxyKeyFunc(trusted),
	})
	next, _ := newCounter()
	h := rl.Middleware(next)

	for i, xff := range []string{"203.0.113.1", "203.0.113.2"} {
		req := httptest.NewRequest(http.MethodGet, "/admin", nil)
		req.RemoteAddr = "198.51.100.7:54321" // untrusted peer
		req.Header.Set("X-Forwarded-For", xff)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		want := http.StatusOK
		if i == 1 {
			want = http.StatusTooManyRequests
		}
		if rr.Code != want {
			t.Fatalf("req %d: want %d, got %d", i, want, rr.Code)
		}
	}
}

func TestTrustedProxyKeyFunc_EmptyTrustedPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on empty trusted list")
		}
	}()
	_ = TrustedProxyKeyFunc(nil)
}

func TestRateLimiter_CustomKeyFunc(t *testing.T) {
	// Bucket by a custom header to demonstrate per-user limiting.
	clk := newFakeTime(time.Unix(1_700_000_000, 0))
	rl := NewRateLimiter(RateLimitConfig{
		Capacity:   1,
		RefillRate: 0.01,
		Clock:      clk,
		KeyFunc: func(r *http.Request) string {
			return r.Header.Get("X-User-ID")
		},
	})
	next, _ := newCounter()
	h := rl.Middleware(next)

	// Empty key → pass through without metering (documented fail-open behavior).
	for i := 0; i < 10; i++ {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("empty-key req %d: want 200, got %d", i, rr.Code)
		}
	}

	// With a user ID — first passes, second 429s.
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("X-User-ID", "alice")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("alice first: want 200, got %d", rr.Code)
	}
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("alice second: want 429, got %d", rr.Code)
	}
}

func TestRateLimiter_MaxKeysEvicts(t *testing.T) {
	clk := newFakeTime(time.Unix(1_700_000_000, 0))
	rl := NewRateLimiter(RateLimitConfig{
		Capacity:   1,
		RefillRate: 0.01,
		MaxKeys:    2,
		Clock:      clk,
	})
	next, _ := newCounter()
	h := rl.Middleware(next)

	for _, ip := range []string{"1.1.1.1", "2.2.2.2", "3.3.3.3"} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, requestFromIP(ip))
		if rr.Code != http.StatusOK {
			t.Fatalf("%s: want 200, got %d", ip, rr.Code)
		}
		clk.Advance(time.Second)
	}

	rl.mu.Lock()
	got := len(rl.buckets)
	rl.mu.Unlock()
	if got > 2 {
		t.Fatalf("bucket map not bounded: have %d, want ≤ 2", got)
	}
}

func TestRateLimiter_ConcurrentSafe(t *testing.T) {
	clk := newFakeTime(time.Unix(1_700_000_000, 0))
	rl := NewRateLimiter(RateLimitConfig{Capacity: 100, RefillRate: 1000, Clock: clk})
	next, _ := newCounter()
	h := rl.Middleware(next)

	var wg sync.WaitGroup
	for g := 0; g < 20; g++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				rr := httptest.NewRecorder()
				h.ServeHTTP(rr, requestFromIP("9.9.9.9"))
				_ = rr.Code // don't assert — we're testing -race, not counts
			}
		}(g)
	}
	wg.Wait()
}

func TestRateLimiter_NilNextPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic")
		}
	}()
	NewRateLimiter(RateLimitConfig{}).Middleware(nil)
}

func TestRateLimiter_LRUEvictsLeastRecentlyUsed(t *testing.T) {
	// With MaxKeys=2 and three distinct keys used in order A→B→A→C, the
	// bucket that should be evicted on C's arrival is B (the least-recently
	// touched), not A — which proves we're doing LRU, not FIFO.
	clk := newFakeTime(time.Unix(1_700_000_000, 0))
	rl := NewRateLimiter(RateLimitConfig{
		Capacity:   10,
		RefillRate: 0.01,
		MaxKeys:    2,
		Clock:      clk,
	})
	next, _ := newCounter()
	h := rl.Middleware(next)

	touch := func(ip string) {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, requestFromIP(ip))
		clk.Advance(time.Second)
	}
	touch("1.1.1.1") // insert A
	touch("2.2.2.2") // insert B
	touch("1.1.1.1") // refresh A → B is now stalest
	touch("3.3.3.3") // insert C, should evict B

	rl.mu.Lock()
	defer rl.mu.Unlock()
	if _, ok := rl.buckets["1.1.1.1"]; !ok {
		t.Error("LRU evicted recently-used key A (1.1.1.1)")
	}
	if _, ok := rl.buckets["3.3.3.3"]; !ok {
		t.Error("LRU dropped newly-inserted key C (3.3.3.3)")
	}
	if _, ok := rl.buckets["2.2.2.2"]; ok {
		t.Error("LRU failed to evict stalest key B (2.2.2.2)")
	}
	if len(rl.buckets) != 2 {
		t.Errorf("map size = %d, want 2", len(rl.buckets))
	}
	if rl.lru.Len() != 2 {
		t.Errorf("LRU list len = %d, want 2", rl.lru.Len())
	}
}

func TestRateLimiter_IdleSweepEvictsStaleBuckets(t *testing.T) {
	// Buckets untouched for longer than IdleTTL get swept opportunistically
	// when another take() runs. This keeps the map from growing without
	// bound even below MaxKeys, so short-burst unique callers eventually
	// release their slots.
	clk := newFakeTime(time.Unix(1_700_000_000, 0))
	rl := NewRateLimiter(RateLimitConfig{
		Capacity:   10,
		RefillRate: 1,
		Clock:      clk,
		IdleTTL:    time.Minute,
	})
	next, _ := newCounter()
	h := rl.Middleware(next)

	// Seed two stale buckets.
	for _, ip := range []string{"1.1.1.1", "2.2.2.2"} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, requestFromIP(ip))
	}
	// Fast-forward well past the TTL.
	clk.Advance(2 * time.Minute)
	// Any take() now should trigger the sweep and then insert the new key.
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, requestFromIP("3.3.3.3"))
	if rr.Code != http.StatusOK {
		t.Fatalf("sweep req: want 200, got %d", rr.Code)
	}

	rl.mu.Lock()
	defer rl.mu.Unlock()
	if _, ok := rl.buckets["1.1.1.1"]; ok {
		t.Error("stale bucket 1.1.1.1 survived idle sweep")
	}
	if _, ok := rl.buckets["2.2.2.2"]; ok {
		t.Error("stale bucket 2.2.2.2 survived idle sweep")
	}
	if _, ok := rl.buckets["3.3.3.3"]; !ok {
		t.Error("new bucket 3.3.3.3 missing after sweep")
	}
}

func TestRateLimiter_RetryAfterCapped(t *testing.T) {
	// With a pathologically slow refill, the raw computed wait would be
	// 100_000 seconds. Middleware must cap the emitted Retry-After at
	// maxRetryAfterSec (3600) so we don't publish absurd values.
	clk := newFakeTime(time.Unix(1_700_000_000, 0))
	rl := NewRateLimiter(RateLimitConfig{Capacity: 1, RefillRate: 1e-5, Clock: clk})
	next, _ := newCounter()
	h := rl.Middleware(next)

	// Consume the single token.
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, requestFromIP("4.4.4.4"))
	if rr.Code != http.StatusOK {
		t.Fatalf("setup: want 200, got %d", rr.Code)
	}
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, requestFromIP("4.4.4.4"))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("want 429, got %d", rr.Code)
	}
	ra, err := strconv.Atoi(rr.Header().Get("Retry-After"))
	if err != nil {
		t.Fatalf("Retry-After parse: %v", err)
	}
	if ra != maxRetryAfterSec {
		t.Fatalf("Retry-After=%d, want %d (cap)", ra, maxRetryAfterSec)
	}
}

func TestRateLimiter_InvalidConfigPanics(t *testing.T) {
	cases := []RateLimitConfig{
		{Capacity: -1},
		{RefillRate: -1},
	}
	for i, c := range cases {
		func(c RateLimitConfig) {
			defer func() {
				if recover() == nil {
					t.Fatalf("case %d: expected panic", i)
				}
			}()
			NewRateLimiter(c)
		}(c)
	}
}

func TestRateLimiter_DefaultsApply(t *testing.T) {
	// Zero config should be usable and use SystemTimeSource. Sanity check:
	// first request passes (capacity ≥ 1 by default).
	rl := NewRateLimiter(RateLimitConfig{})
	next, _ := newCounter()
	h := rl.Middleware(next)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, requestFromIP("1.2.3.4"))
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr.Code)
	}
}
