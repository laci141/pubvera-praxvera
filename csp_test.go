package main

import (
	"errors"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"
)

// CSP phase 2: every <script> tag in index.html carries nonce="__CSP_NONCE__",
// and each index response replaces that marker with a fresh nonce named in the
// enforcing Content-Security-Policy header. Style S1: the one <style> tag
// carries the same marker, and the style policy is sent as
// Content-Security-Policy-Report-Only with the same nonce. All requests go in-process
// through getRoot (root_cache_test.go), on handleRoot or on newMux().

// wantPolicy is written out here rather than taken from contentSecurityPolicy,
// so a change to any directive in csp.go fails a test.
func wantPolicy(nonce string) string {
	return "script-src 'nonce-" + nonce + "' 'strict-dynamic' https: 'unsafe-inline'; script-src-attr 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
}

// wantStylePolicy is the S1 Report-Only style policy, written out for the same
// reason.
func wantStylePolicy(nonce string) string {
	return "style-src 'nonce-" + nonce + "'; style-src-attr 'none'"
}

// The header names and the marker are spelled out so a renamed constant cannot
// agree with itself.
const (
	reportOnlyHeader = "Content-Security-Policy-Report-Only"
	enforcingHeader  = "Content-Security-Policy"
	nonceMarkerText  = "__CSP_NONCE__"
)

// index.html has 4 <script> tags: the external xlsx-js-style bundle, two
// classic inline scripts and one module.
const wantScriptTags = 4

// index.html has exactly one <style> tag; it carries the nonce too (style S1).
const wantStyleTags = 1

var styleOpenRE = regexp.MustCompile(`<style\b[^>]*>`)

// 22-character nonce in the Report-Only style policy.
var styleNonceRE = regexp.MustCompile(`^style-src 'nonce-([A-Za-z0-9+/]{22})'; style-src-attr 'none'$`)

// 16 random bytes in raw standard base64 are exactly 22 characters.
var cspNonceRE = regexp.MustCompile(`^script-src 'nonce-([A-Za-z0-9+/]{22})' `)

var scriptOpenRE = regexp.MustCompile(`<script\b[^>]*>`)

var bodyNonceRE = regexp.MustCompile(`nonce="([^"]*)"`)

// indexNonce fetches / and returns the header nonce, body and headers. It
// stops the test when there is no nonce to compare against; the header checks
// themselves live in the tests below.
func indexNonce(t *testing.T) (string, string, http.Header) {
	t.Helper()
	rec := getRoot(t, http.HandlerFunc(handleRoot), "/", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /: status = %d, want 200", rec.Code)
	}
	csp := rec.Header().Get(enforcingHeader)
	m := cspNonceRE.FindStringSubmatch(csp)
	if m == nil {
		t.Fatalf("GET /: %s = %q, want a policy with a 22-character nonce", enforcingHeader, csp)
	}
	return m[1], rec.Body.String(), rec.Header()
}

func TestCSPMarkerReplacedInResponse(t *testing.T) {
	nonce, body, _ := indexNonce(t)
	if strings.Contains(body, nonceMarkerText) {
		t.Errorf("GET /: body still contains %s", nonceMarkerText)
	}
	if n := strings.Count(body, `nonce="`+nonce+`"`); n != wantScriptTags+wantStyleTags {
		t.Errorf("GET /: %d tags carry the header nonce, want %d", n, wantScriptTags+wantStyleTags)
	}
}

func TestCSPNonceIsFreshPerResponse(t *testing.T) {
	a, _, _ := indexNonce(t)
	b, _, _ := indexNonce(t)
	if a == b {
		t.Errorf("two responses carried the same nonce %q", a)
	}
}

func TestCSPHeaderNonceMatchesEveryBodyNonce(t *testing.T) {
	nonce, body, _ := indexNonce(t)
	tags := scriptOpenRE.FindAllString(body, -1)
	if len(tags) != wantScriptTags {
		t.Errorf("GET /: %d <script> tags, want %d", len(tags), wantScriptTags)
	}
	for _, tag := range tags {
		if !strings.Contains(tag, ` nonce="`+nonce+`"`) {
			t.Errorf("GET /: tag %s does not carry the header nonce %q", tag, nonce)
		}
	}
	for _, m := range bodyNonceRE.FindAllStringSubmatch(body, -1) {
		if m[1] != nonce {
			t.Errorf("GET /: body nonce %q differs from header nonce %q", m[1], nonce)
		}
	}
}

func TestCSPHeaderIsEnforcingWithExactPolicy(t *testing.T) {
	nonce, _, h := indexNonce(t)
	if got := h.Get(enforcingHeader); got != wantPolicy(nonce) {
		t.Errorf("%s = %q, want %q", enforcingHeader, got, wantPolicy(nonce))
	}
	if cspHeaderName != enforcingHeader {
		t.Errorf("cspHeaderName = %q, want %q", cspHeaderName, enforcingHeader)
	}
}

// TestCSPIndexSendsBothHeaders does not use indexNonce, so a missing enforcing
// header fails here directly. Style S1: exactly one Report-Only header, carrying
// only the style policy, with the enforcing header's nonce.
func TestCSPIndexSendsBothHeaders(t *testing.T) {
	rec := getRoot(t, http.HandlerFunc(handleRoot), "/", "")
	enf := rec.Header().Get(enforcingHeader)
	if enf == "" {
		t.Errorf("GET /: %s = %q, want a policy", enforcingHeader, enf)
	}
	if n := len(rec.Header().Values(reportOnlyHeader)); n != 1 {
		t.Errorf("GET /: %d %s headers, want 1", n, reportOnlyHeader)
	}
	ro := rec.Header().Get(reportOnlyHeader)
	m := styleNonceRE.FindStringSubmatch(ro)
	if m == nil {
		t.Fatalf("GET /: %s = %q, want %q", reportOnlyHeader, ro, wantStylePolicy("<22-char nonce>"))
	}
	if e := cspNonceRE.FindStringSubmatch(enf); e == nil || e[1] != m[1] {
		t.Errorf("GET /: Report-Only nonce %q differs from the enforcing header %q", m[1], enf)
	}
}

// Both headers pinned as full literals through the real handler, for the nonce
// that 16 zero bytes give, so a one-character change in csp.go fails here. The
// enforcing value is the one Praxvera sent before style S1.
func TestCSPHeadersPinnedLiteral(t *testing.T) {
	orig := nonceRandRead
	nonceRandRead = func(b []byte) (int, error) { clear(b); return len(b), nil }
	defer func() { nonceRandRead = orig }()
	rec := getRoot(t, http.HandlerFunc(handleRoot), "/", "")
	const wantEnf = "script-src 'nonce-AAAAAAAAAAAAAAAAAAAAAA' 'strict-dynamic' https: 'unsafe-inline'; script-src-attr 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
	const wantRO = "style-src 'nonce-AAAAAAAAAAAAAAAAAAAAAA'; style-src-attr 'none'"
	if got := rec.Header().Get(enforcingHeader); got != wantEnf {
		t.Errorf("GET /: %s = %q, want %q", enforcingHeader, got, wantEnf)
	}
	if got := rec.Header().Get(reportOnlyHeader); got != wantRO {
		t.Errorf("GET /: %s = %q, want %q", reportOnlyHeader, got, wantRO)
	}
}

// One nonce per response: enforcing header, Report-Only header and the served
// <style> tag all carry it.
func TestCSPStyleTagCarriesTheResponseNonce(t *testing.T) {
	nonce, body, h := indexNonce(t)
	if got, want := h.Get(reportOnlyHeader), wantStylePolicy(nonce); got != want {
		t.Errorf("%s = %q, want %q", reportOnlyHeader, got, want)
	}
	tags := styleOpenRE.FindAllString(body, -1)
	if len(tags) != wantStyleTags {
		t.Errorf("GET /: %d <style> tags, want %d", len(tags), wantStyleTags)
	}
	for _, tag := range tags {
		if !strings.Contains(tag, ` nonce="`+nonce+`"`) {
			t.Errorf("GET /: tag %s does not carry the header nonce %q", tag, nonce)
		}
	}
}

// Never stored, so a cached copy cannot replay one nonce to every visitor.
func TestCSPIndexIsNoStore(t *testing.T) {
	rec := getRoot(t, http.HandlerFunc(handleRoot), "/", "")
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("GET /: Cache-Control = %q, want %q", cc, "no-store")
	}
}

func TestCSPIndexFileMarksEveryScript(t *testing.T) {
	data, err := os.ReadFile("index.html")
	if err != nil {
		t.Fatal(err)
	}
	tags := scriptOpenRE.FindAll(data, -1)
	if len(tags) != wantScriptTags {
		t.Errorf("index.html: %d <script> tags, want %d", len(tags), wantScriptTags)
	}
	for _, tag := range tags {
		if !strings.Contains(string(tag), ` nonce="`+nonceMarkerText+`"`) {
			t.Errorf("index.html: tag %s has no nonce marker", tag)
		}
	}
	styles := styleOpenRE.FindAll(data, -1)
	if len(styles) != wantStyleTags {
		t.Errorf("index.html: %d <style> tags, want %d", len(styles), wantStyleTags)
	}
	for _, tag := range styles {
		if !strings.Contains(string(tag), ` nonce="`+nonceMarkerText+`"`) {
			t.Errorf("index.html: tag %s has no nonce marker", tag)
		}
	}
	if n := strings.Count(string(data), nonceMarkerText); n != wantScriptTags+wantStyleTags {
		t.Errorf("index.html: %s appears %d times, want %d", nonceMarkerText, n, wantScriptTags+wantStyleTags)
	}
}

// Fail closed: no nonce means no page and no policy.
func TestCSPRandFailureIs500(t *testing.T) {
	orig := nonceRandRead
	nonceRandRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
	defer func() { nonceRandRead = orig }()
	rec := getRoot(t, http.HandlerFunc(handleRoot), "/", "")
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("GET /: status = %d, want 500", rec.Code)
	}
	for _, name := range []string{reportOnlyHeader, enforcingHeader} {
		if got := rec.Header().Get(name); got != "" {
			t.Errorf("GET /: %s = %q, want none", name, got)
		}
	}
	if body := rec.Body.String(); strings.Contains(body, "<script") {
		t.Errorf("GET /: body contains <script despite nonce failure")
	}
}

// A missing index.html answers what http.ServeFile answered before phase 1
// (measured): 404 "404 page not found\n", and it carries no policy and no
// index-page no-store.
func TestCSPMissingIndexIs404WithoutPolicy(t *testing.T) {
	t.Chdir(t.TempDir()) // no index.html to read here
	rec := getRoot(t, http.HandlerFunc(handleRoot), "/", "")
	if rec.Code != http.StatusNotFound {
		t.Errorf("GET /: status = %d, want 404", rec.Code)
	}
	if got, want := rec.Body.String(), "404 page not found\n"; got != want {
		t.Errorf("GET /: body = %q, want %q", got, want)
	}
	if cc := rec.Header().Get("Cache-Control"); cc == "no-store" {
		t.Errorf("GET /: Cache-Control = %q, want anything but %q", cc, "no-store")
	}
	for _, name := range []string{reportOnlyHeader, enforcingHeader} {
		if got := rec.Header().Get(name); got != "" {
			t.Errorf("GET /: %s = %q, want none", name, got)
		}
	}
}

// /healthz and /version are registered on newMux(), not in handleRoot, so
// this test goes through the full route table.
func TestCSPOnlyOnTheIndexPage(t *testing.T) {
	mux := newMux()
	for _, path := range []string{"/nope", "/config.json", "/healthz"} {
		rec := getRoot(t, mux, path, "")
		for _, name := range []string{reportOnlyHeader, enforcingHeader} {
			if got := rec.Header().Get(name); got != "" {
				t.Errorf("GET %s: %s = %q, want none", path, name, got)
			}
		}
	}
}
