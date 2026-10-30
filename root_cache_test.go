package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The index page must never be stored, so a deploy is visible on the next load
// instead of whenever a browser's heuristic cache expires, and a cached copy
// cannot replay one CSP nonce to every visitor. Each response carries a fresh
// nonce in both the header and the body, so a 304 must never happen: the
// browser would keep the old page (old nonce) under the new header nonce and
// every script would be blocked once the policy enforces. no-store and no
// Last-Modified give a browser nothing to revalidate with. main() serves
// newMux(), which registers handleRoot for "/", so the tests drive handleRoot
// directly.

func getRoot(t *testing.T, h http.Handler, path, ifModifiedSince string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if ifModifiedSince != "" {
		req.Header.Set("If-Modified-Since", ifModifiedSince)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestIndexIsNeverStored(t *testing.T) {
	mux := http.HandlerFunc(handleRoot)

	first := getRoot(t, mux, "/", "")
	if first.Code != http.StatusOK {
		t.Fatalf("GET /: status = %d, want 200", first.Code)
	}
	if cc := first.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("GET /: Cache-Control = %q, want %q", cc, "no-store")
	}
	if lm := first.Header().Get("Last-Modified"); lm != "" {
		t.Errorf("GET /: Last-Modified = %q, want none", lm)
	}

	// A date in the future is newer than any index.html, so a handler that
	// honours If-Modified-Since would answer 304 here.
	second := getRoot(t, mux, "/", "Fri, 01 Jan 2100 00:00:00 GMT")
	if second.Code != http.StatusOK {
		t.Fatalf("GET / with If-Modified-Since: status = %d, want 200, never 304", second.Code)
	}
	if cc := second.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("GET / with If-Modified-Since: Cache-Control = %q, want %q", cc, "no-store")
	}
	if body := second.Body.String(); !strings.Contains(body, "</html>") {
		t.Errorf("GET / with If-Modified-Since: body is %d bytes without </html>, want the full page", len(body))
	}
	a := first.Header().Get(enforcingHeader)
	b := second.Header().Get(enforcingHeader)
	if a == "" || a == b {
		t.Errorf("GET / with If-Modified-Since: %s = %q after %q, want a fresh nonce", enforcingHeader, b, a)
	}
}

func TestConfigStaysNoStore(t *testing.T) {
	rec := getRoot(t, http.HandlerFunc(handleRoot), "/config.json", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /config.json: status = %d, want 200", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("GET /config.json: Cache-Control = %q, want %q", cc, "no-store")
	}
}

func TestUnknownPathIs404(t *testing.T) {
	if rec := getRoot(t, http.HandlerFunc(handleRoot), "/nope", ""); rec.Code != http.StatusNotFound {
		t.Errorf("GET /nope: status = %d, want 404", rec.Code)
	}
}
