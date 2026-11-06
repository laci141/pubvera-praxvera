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
// enforcing Content-Security-Policy header. Style S2: the one <style> tag
// carries the same marker, and the style policy is part of that one enforcing
// header. The only Content-Security-Policy-Report-Only header is connect-src
// (csp_report.go). All requests go in-process through getRoot
// (root_cache_test.go), on handleRoot or on newMux().

// wantPolicy is written out here rather than taken from contentSecurityPolicy,
// so a change to any directive in csp.go fails a test.
func wantPolicy(nonce string) string {
	return "script-src 'nonce-" + nonce + "' 'strict-dynamic' https: 'unsafe-inline'; script-src-attr 'none'; " + wantStylePolicy(nonce) + "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
}

// wantStylePolicy is the style part of the enforcing policy (S2), written out
// for the same reason.
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

// index.html has exactly one <style> tag; it carries the nonce too (style S1/S2).
const wantStyleTags = 1

var styleOpenRE = regexp.MustCompile(`<style\b[^>]*>`)

// Both 22-character nonces of the enforcing policy: script-src and style-src.
var bothNoncesRE = regexp.MustCompile(`^script-src 'nonce-([A-Za-z0-9+/]{22})' 'strict-dynamic' https: 'unsafe-inline'; script-src-attr 'none'; style-src 'nonce-([A-Za-z0-9+/]{22})'; style-src-attr 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'$`)

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

// TestCSPIndexSendsOneEnforcingHeader replaces S1's TestCSPIndexSendsBothHeaders
// on purpose: S1 required a Report-Only style header, S2 forbids it. connect-src
// PR A brings a Report-Only header back, for connect-src only: exactly the value
// of reportOnlyConnectSrc for the test environment. It does not use indexNonce,
// so a missing enforcing header fails here directly.
// Header().Set keeps only the last value, so two Set calls on one name would
// silently drop a policy; exactly one value, equal to the full policy, is required.
func TestCSPIndexSendsOneEnforcingHeader(t *testing.T) {
	_, _, origin := supabaseConfig()
	rec := getRoot(t, http.HandlerFunc(handleRoot), "/", "")
	enf := rec.Header().Values(enforcingHeader)
	if len(enf) != 1 {
		t.Fatalf("GET /: %d %s headers %q, want 1", len(enf), enforcingHeader, enf)
	}
	m := bothNoncesRE.FindStringSubmatch(enf[0])
	if m == nil || enf[0] != wantPolicy(m[1]) {
		t.Errorf("GET /: %s = %q, want %q", enforcingHeader, enf[0], wantPolicy("<22-char nonce>"))
	}
	if got := rec.Header().Values(reportOnlyHeader); len(got) != 1 || got[0] != reportOnlyConnectSrc(origin) {
		t.Errorf("GET /: %s headers %q, want exactly [%q]", reportOnlyHeader, got, reportOnlyConnectSrc(origin))
	}
}

// The enforcing header is pinned as a full literal through the real handler,
// for the nonce that 16 zero bytes give, so a one-character change in csp.go
// fails here. Style S2: the style directives sit after script-src-attr, in the
// Recallis order. connect-src PR A: the Report-Only header carries connect-src
// alone, pinned here for an environment without Supabase.
func TestCSPHeadersPinnedLiteral(t *testing.T) {
	t.Setenv("SUPABASE_URL", "")
	t.Setenv("SUPABASE_PUBLISHABLE_KEY", "")
	orig := nonceRandRead
	nonceRandRead = func(b []byte) (int, error) { clear(b); return len(b), nil }
	defer func() { nonceRandRead = orig }()
	rec := getRoot(t, http.HandlerFunc(handleRoot), "/", "")
	const wantEnf = "script-src 'nonce-AAAAAAAAAAAAAAAAAAAAAA' 'strict-dynamic' https: 'unsafe-inline'; script-src-attr 'none'; style-src 'nonce-AAAAAAAAAAAAAAAAAAAAAA'; style-src-attr 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
	if got := rec.Header().Get(enforcingHeader); got != wantEnf {
		t.Errorf("GET /: %s = %q, want %q", enforcingHeader, got, wantEnf)
	}
	const wantRO = "connect-src 'self'; report-to csp; report-uri /csp-report"
	if got := rec.Header().Values(reportOnlyHeader); len(got) != 1 || got[0] != wantRO {
		t.Errorf("GET /: %s = %q, want [%q]", reportOnlyHeader, got, wantRO)
	}
	if got, want := rec.Header().Get("Reporting-Endpoints"), `csp="/csp-report"`; got != want {
		t.Errorf("GET /: Reporting-Endpoints = %q, want %q", got, want)
	}
}

// One nonce per response: the script-src nonce, the style-src nonce and the
// served <style> tag all carry it.
func TestCSPStyleTagCarriesTheResponseNonce(t *testing.T) {
	nonce, body, h := indexNonce(t)
	enf := h.Get(enforcingHeader)
	m := bothNoncesRE.FindStringSubmatch(enf)
	if m == nil {
		t.Fatalf("GET /: %s = %q, want %q", enforcingHeader, enf, wantPolicy("<22-char nonce>"))
	}
	if m[1] != nonce || m[2] != nonce {
		t.Errorf("GET /: script nonce %q, style nonce %q, want both %q", m[1], m[2], nonce)
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
