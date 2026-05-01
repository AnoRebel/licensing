//go:build ignore
// +build ignore

// Client example: activate → heartbeat → refresh → deactivate.
//
// Uses a mocked http.RoundTripper so the example runs offline. Replace
// `mockTransport` with http.DefaultTransport pointed at your issuer to run
// it for real.
//
// Run: cd golang && go run ./examples/client_flow.go

package main

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/AnoRebel/licensing/licensing/client"
)

const fakeToken = "LIC1.eyJ2IjoxfQ.eyJleHAiOjk5OTk5OTk5OTl9.sig"

type mockTransport struct{}

func (mockTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	path := req.URL.Path
	mkJSON := func(status int, body string) *http.Response {
		return &http.Response{
			StatusCode: status,
			Body:       io.NopCloser(bytes.NewBufferString(body)),
			Header:     http.Header{"Content-Type": []string{"application/json"}},
		}
	}
	ok := func(data string) *http.Response {
		return mkJSON(200, fmt.Sprintf(`{"success":true,"data":%s}`, data))
	}
	switch {
	case strings.HasSuffix(path, "/activate"):
		return ok(fmt.Sprintf(
			`{"token":%q,"license_id":"lic_01HX","usage_id":"usg_01HX"}`, fakeToken)), nil
	case strings.HasSuffix(path, "/refresh"):
		return ok(fmt.Sprintf(`{"token":%q,"exp":9999999999}`, fakeToken)), nil
	case strings.HasSuffix(path, "/heartbeat"):
		return ok(`{"ok":true}`), nil
	case strings.HasSuffix(path, "/deactivate"):
		return ok(`{"deactivated":true}`), nil
	}
	return mkJSON(404, `{"success":false,"error":{"code":"NotFound","message":"not found"}}`), nil
}

func main() {
	httpClient := &http.Client{Transport: mockTransport{}}
	transport := client.TransportOptions{
		BaseURL: "https://licensing.example.com",
		Client:  httpClient,
	}
	fingerprint := strings.Repeat("b", 64)
	licenseKey := "LK-DEMO-0000-0000"
	store := client.NewMemoryTokenStore()

	// 1. Activate — first run, exchange license key for a token.
	activated, err := client.Activate(licenseKey, client.ActivateOptions{
		Transport:   transport,
		Fingerprint: fingerprint,
		Store:       store,
	})
	if err != nil {
		log.Fatalf("Activate: %v", err)
	}
	fmt.Println("Activated:", activated.LicenseID, activated.UsageID)

	// 2. Read the cached token state.
	state, _ := store.Read()
	fmt.Println("Cached token present:", state.Token != "")

	// 3. Heartbeat — returns a bool, reports errors via OnError. The
	//    body sent to the issuer is `{token}` read from Store; the
	//    server derives identity from the token's claims.
	ok := client.SendOneHeartbeat(client.HeartbeatOptions{
		Transport: transport,
		Store:     store,
		OnError:   func(err error) { log.Printf("heartbeat err: %v", err) },
	})
	fmt.Println("Heartbeat OK:", ok)

	// 4. Refresh — rotates the token before exp. (Skipped in this example
	//    because we stored a fake token; a real flow would have a LIC1
	//    token minted by the issuer, and client.Refresh would inspect its
	//    exp before deciding to call the server.)
	_, _ = client.Refresh(client.RefreshOptions{Transport: transport, Store: store})
	fmt.Println("Refresh path: (skipped in mock — needs a real LIC1 token)")

	// 5. Deactivate — releases the seat server-side, clears local store.
	if _, err := client.Deactivate("user requested", client.DeactivateOptions{
		Transport:   transport,
		Store:       store,
		LicenseKey:  licenseKey,
		Fingerprint: fingerprint,
	}); err != nil {
		log.Fatalf("Deactivate: %v", err)
	}
	state, _ = store.Read()
	fmt.Println("Deactivated; store cleared:", state.Token == "")
}
