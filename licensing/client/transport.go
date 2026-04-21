package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// TransportOptions configures the shared HTTP layer.
type TransportOptions struct {
	Client    *http.Client
	Headers   map[string]string
	BaseURL   string
	TimeoutMs int
}

func (o TransportOptions) timeout() time.Duration {
	if o.TimeoutMs > 0 {
		return time.Duration(o.TimeoutMs) * time.Millisecond
	}
	return 15 * time.Second
}

func (o TransportOptions) httpClient() *http.Client {
	if o.Client != nil {
		return o.Client
	}
	// Do not use http.DefaultClient — it has no timeout.
	return &http.Client{Timeout: o.timeout()}
}

// issuerResponse is the shape returned by the issuer API.
type issuerResponse struct {
	Error   *issuerError    `json:"error"`
	Data    json.RawMessage `json:"data"`
	Success bool            `json:"success"`
}

type issuerError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// PostJSON sends a JSON POST to the issuer and decodes the response into T.
func PostJSON[T any](path string, body any, opts TransportOptions) (T, error) {
	var zero T
	url := joinURL(opts.BaseURL, path)

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return zero, fmt.Errorf("marshal request: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), opts.timeout())
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(bodyBytes))
	if err != nil {
		return zero, IssuerUnreachable("failed to create request", err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range opts.Headers {
		req.Header.Set(k, v)
	}

	resp, err := opts.httpClient().Do(req)
	if err != nil {
		return zero, IssuerUnreachable("", err)
	}
	defer resp.Body.Close()

	// HTTP 429 → RateLimited.
	if resp.StatusCode == http.StatusTooManyRequests {
		retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"))
		return zero, RateLimited(retryAfter, "")
	}

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return zero, IssuerUnreachable("failed to read response body", err)
	}

	var envelope issuerResponse
	if err := json.Unmarshal(respBody, &envelope); err != nil {
		// Non-JSON response → treat as unreachable (misconfigured proxy).
		return zero, IssuerUnreachable("non-JSON response from issuer", err)
	}

	if !envelope.Success {
		if envelope.Error != nil {
			return zero, FromIssuerCode(
				envelope.Error.Code,
				envelope.Error.Message,
				resp.StatusCode,
				0,
			)
		}
		return zero, IssuerUnreachable("issuer returned unsuccessful response", nil)
	}

	var result T
	if err := json.Unmarshal(envelope.Data, &result); err != nil {
		return zero, IssuerUnreachable("failed to decode response data", err)
	}
	return result, nil
}

func joinURL(base, path string) string {
	base = strings.TrimRight(base, "/")
	path = strings.TrimLeft(path, "/")
	return base + "/" + path
}

// retryAfterMaxSec caps server-suggested backoff to 24h to prevent an
// attacker-controlled issuer from inducing app-layer DoS via absurdly long
// Retry-After values.
const retryAfterMaxSec = 86400

func parseRetryAfter(header string) int {
	if header == "" {
		return 60
	}
	sec, err := strconv.Atoi(header)
	if err != nil || sec <= 0 {
		// RFC 7231 also allows HTTP-date form; we intentionally don't honor
		// it — fall back to a safe default.
		return 60
	}
	if sec > retryAfterMaxSec {
		return retryAfterMaxSec
	}
	return sec
}
