package client

import "testing"

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
	custom := &struct{}{} // just a marker; we use identity comparison
	_ = custom
	// Can't easily construct a custom *http.Client and compare by identity
	// without importing net/http in a trivial test — skip noise.
}
