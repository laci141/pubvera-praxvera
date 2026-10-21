package main

import (
	"bytes"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const auditSentinel = "AUDIT_SECRET_SENTINEL_12345"

// captureLog redirects the standard logger into a buffer until the test ends.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(prev) })
	return &buf
}

func assertNoKeyLeak(t *testing.T, where, s string) {
	t.Helper()
	for _, bad := range []string{auditSentinel, "api_key="} {
		if strings.Contains(s, bad) {
			t.Errorf("%s leaks %q: %s", where, bad, s)
		}
	}
}

// TestSearchUnreachableUpstreamDoesNotLogKey pins F-01: a transport error must
// not write the request URL (and so the API key) to the log.
func TestSearchUnreachableUpstreamDoesNotLogKey(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	base := "http://" + ln.Addr().String()
	ln.Close()
	t.Setenv("OPENALEX_BASE", base)
	t.Setenv("OPENALEX_API_KEY", auditSentinel)

	buf := captureLog(t)
	rec := httptest.NewRecorder()
	handleSearch(rec, httptest.NewRequest(http.MethodPost, "/api/search", strings.NewReader(`{"query":"x"}`)))

	if rec.Code != http.StatusBadGateway && rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, want 502 or 504", rec.Code)
	}
	assertNoKeyLeak(t, "response body", rec.Body.String())
	assertNoKeyLeak(t, "log", buf.String())
	if !strings.Contains(buf.String(), "openalex request failed: ") {
		t.Errorf("log = %q, want a category-only failure line", buf.String())
	}
}

// TestSearchUpstreamErrorBodyDoesNotLogKey covers an upstream that echoes the
// query string (with the key) in its error body.
func TestSearchUpstreamErrorBodyDoesNotLogKey(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte("bad request: " + r.URL.RawQuery))
	}))
	defer fake.Close()
	t.Setenv("OPENALEX_BASE", fake.URL)
	t.Setenv("OPENALEX_API_KEY", auditSentinel)

	buf := captureLog(t)
	rec := httptest.NewRecorder()
	handleSearch(rec, httptest.NewRequest(http.MethodPost, "/api/search", strings.NewReader(`{"query":"x"}`)))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	assertNoKeyLeak(t, "response body", rec.Body.String())
	assertNoKeyLeak(t, "log", buf.String())
}
