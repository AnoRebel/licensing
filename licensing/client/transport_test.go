package client

import (
	"net/http"
	"testing"
	"time"
)

func TestParseRetryAfter(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 60},
		{"not-a-number", 60},
		{"0", 60},
		{"-5", 60},
		{"30", 30},
		{"86400", 86400},
		{"999999", 86400}, // capped
		{"2147483647", 86400},
	}
	for _, tc := range cases {
		got := parseRetryAfter(tc.in)
		if got != tc.want {
			t.Errorf("parseRetryAfter(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestTransportOptions_DefaultClientHasTimeout(t *testing.T) {
	opts := TransportOptions{}
	c := opts.httpClient()
	if c.Timeout == 0 {
		t.Fatal("default client must have a timeout (avoid hung goroutines)")
	}
}

func TestTransportOptions_CustomClientRespected(t *testing.T) {
	// The previous body constructed an unused marker value and asserted
	// nothing, so it passed whether or not a custom client was honoured.
	// net/http is already an ordinary dependency here, so identity
	// comparison is straightforward.
	custom := &http.Client{Timeout: 3 * time.Second}
	opts := TransportOptions{Client: custom}
	if got := opts.httpClient(); got != custom {
		t.Fatalf("custom client not respected: got %p, want %p", got, custom)
	}
}

func TestTransportOptions_DefaultClientWhenUnset(t *testing.T) {
	opts := TransportOptions{}
	first := opts.httpClient()
	if first == nil {
		t.Fatal("default client must not be nil")
	}
	if first.Timeout == 0 {
		t.Fatal("default client must have a timeout (avoid hung goroutines)")
	}
}
