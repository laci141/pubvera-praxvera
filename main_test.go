package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// workWithAuthors builds an openAlexWork whose Authorships hold the given
// display names. The Authorships field is an anonymous struct type, so it is
// populated through JSON rather than a struct literal that would have to
// restate every tag.
func workWithAuthors(t *testing.T, names ...string) openAlexWork {
	t.Helper()
	type author struct {
		DisplayName string `json:"display_name"`
	}
	type authorship struct {
		Author author `json:"author"`
	}
	payload := struct {
		Authorships []authorship `json:"authorships"`
	}{}
	for _, n := range names {
		payload.Authorships = append(payload.Authorships, authorship{Author: author{DisplayName: n}})
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	var w openAlexWork
	if err := json.Unmarshal(raw, &w); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	return w
}

func TestDecodeAbstract(t *testing.T) {
	tests := []struct {
		name string
		inv  map[string][]int
		want string
	}{
		{
			name: "nil index yields empty abstract rather than panicking",
			inv:  nil,
			want: "",
		},
		{
			name: "empty index yields empty abstract",
			inv:  map[string][]int{},
			want: "",
		},
		{
			name: "single word is returned unchanged without stray spaces",
			inv:  map[string][]int{"Randomised": {0}},
			want: "Randomised",
		},
		{
			name: "a word repeated at several positions is emitted once per position",
			inv: map[string][]int{
				"the":   {0, 2, 4},
				"of":    {1},
				"study": {3},
				"drug":  {5},
			},
			want: "the of the study the drug",
		},
		{
			// Alphabetical order (alpha, beta, gamma, zeta) and Go's randomised
			// map iteration both differ from the positional order asserted here,
			// so this case fails if the sort by position is ever dropped.
			name: "words are ordered by position, not by map iteration or alphabet",
			inv: map[string][]int{
				"zeta":  {0},
				"gamma": {1},
				"beta":  {2},
				"alpha": {3},
			},
			want: "zeta gamma beta alpha",
		},
		{
			name: "non-contiguous positions are still ordered ascending",
			inv: map[string][]int{
				"second": {50},
				"first":  {7},
				"third":  {900},
			},
			want: "first second third",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := decodeAbstract(tt.inv); got != tt.want {
				t.Errorf("decodeAbstract() = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestDecodeAbstractDuplicatePositionIsDeterministic pins the tiebreak. Two
// words at the same position used to render in either order — sort.Slice is
// unstable and the slice it sorts is built by ranging over a map, whose order
// Go randomises. Measured at roughly 13% of a thousand runs inside one
// process, which is exactly the kind of defect that survives a green test
// suite. The tiebreak on the word itself fixes it; a single call cannot prove
// that, so this repeats and requires every result to be identical.
func TestDecodeAbstractDuplicatePositionIsDeterministic(t *testing.T) {
	inv := map[string][]int{
		"start": {0},
		"alpha": {1},
		"beta":  {1},
		"end":   {2},
	}

	const want = "start alpha beta end"
	for i := 0; i < 200; i++ {
		if got := decodeAbstract(inv); got != want {
			t.Fatalf("decodeAbstract() on run %d = %q, want %q — the tie is not broken deterministically", i, got, want)
		}
	}
}

func TestAuthorsStr(t *testing.T) {
	tests := []struct {
		name  string
		names []string
		want  string
	}{
		{
			name:  "no authorships yields an empty string",
			names: nil,
			want:  "",
		},
		{
			name:  "a single author is returned without separators",
			names: []string{"Ada Lovelace"},
			want:  "Ada Lovelace",
		},
		{
			name:  "three authors are listed in full",
			names: []string{"A One", "B Two", "C Three"},
			want:  "A One, B Two, C Three",
		},
		{
			name:  "four authors are listed in full without et al.",
			names: []string{"A One", "B Two", "C Three", "D Four"},
			want:  "A One, B Two, C Three, D Four",
		},
		{
			name:  "five authors are truncated to four followed by et al.",
			names: []string{"A One", "B Two", "C Three", "D Four", "E Five"},
			want:  "A One, B Two, C Three, D Four et al.",
		},
		{
			name:  "a blank display name is skipped so five authorships yield four names and no et al.",
			names: []string{"A One", "", "B Two", "C Three", "D Four"},
			want:  "A One, B Two, C Three, D Four",
		},
		{
			name:  "blank display names alone yield an empty string",
			names: []string{"", ""},
			want:  "",
		},
		{
			name:  "a blank name does not consume a truncation slot",
			names: []string{"A One", "B Two", "", "C Three", "D Four", "E Five"},
			want:  "A One, B Two, C Three, D Four et al.",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := authorsStr(workWithAuthors(t, tt.names...))
			if got != tt.want {
				t.Errorf("authorsStr() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestAuthorsFullStr(t *testing.T) {
	tests := []struct {
		name  string
		names []string
		want  string
	}{
		{
			name:  "no authorships yields an empty string",
			names: nil,
			want:  "",
		},
		{
			name:  "a single author is returned without a separator",
			names: []string{"Ada Lovelace"},
			want:  "Ada Lovelace",
		},
		{
			name:  "authors are joined with the BibTeX and separator",
			names: []string{"A One", "B Two", "C Three"},
			want:  "A One and B Two and C Three",
		},
		{
			name:  "five authors are all kept, unlike the truncating short form",
			names: []string{"A One", "B Two", "C Three", "D Four", "E Five"},
			want:  "A One and B Two and C Three and D Four and E Five",
		},
		{
			name:  "a blank display name is skipped without leaving a dangling separator",
			names: []string{"A One", "", "B Two"},
			want:  "A One and B Two",
		},
		{
			name:  "author order follows the authorship order, not sorted",
			names: []string{"Zeta Last", "Alpha First"},
			want:  "Zeta Last and Alpha First",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := authorsFullStr(workWithAuthors(t, tt.names...))
			if got != tt.want {
				t.Errorf("authorsFullStr() = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestSearchIsRetractedComesFromOpenAlexField drives handleSearch against a fake
// OpenAlex server, so it pins the real mapping from the upstream JSON to the
// article the browser receives. The title prefix is not evidence either way:
// case b has the "RETRACTED:" prefix but OpenAlex says false, and case a is
// retracted per OpenAlex with a title that carries no prefix.
func TestSearchIsRetractedComesFromOpenAlexField(t *testing.T) {
	tests := []struct {
		name string
		work string
		want bool
	}{
		{
			name: "is_retracted true with a normal title is retracted",
			work: `{"title":"A randomised trial of X","is_retracted":true}`,
			want: true,
		},
		{
			name: "is_retracted false with a RETRACTED: title prefix is not retracted",
			work: `{"title":"RETRACTED: A randomised trial of X","is_retracted":false}`,
			want: false,
		},
		{
			name: "missing is_retracted field is not retracted",
			work: `{"title":"A randomised trial of X"}`,
			want: false,
		},
		{
			name: "normal article with is_retracted false is not retracted",
			work: `{"title":"A randomised trial of X","is_retracted":false}`,
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"results":[` + tt.work + `],"meta":{"count":1}}`))
			}))
			defer fake.Close()
			t.Setenv("OPENALEX_BASE", fake.URL)

			req := httptest.NewRequest(http.MethodPost, "/api/search", strings.NewReader(`{"query":"x"}`))
			rec := httptest.NewRecorder()
			handleSearch(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
			}

			var out struct {
				Articles []article `json:"articles"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if len(out.Articles) != 1 {
				t.Fatalf("got %d articles, want 1", len(out.Articles))
			}
			if got := out.Articles[0].IsRetracted; got != tt.want {
				t.Errorf("IsRetracted = %v, want %v", got, tt.want)
			}
		})
	}
}

// TestSearchRequestBodyLimit pins the byte cap on the /api/search body. A
// legitimate request is under 1 KiB, and ReadTimeout limits time, not size, so
// without the cap a client can make the handler buffer an arbitrarily large
// "query". Case a also counts upstream calls: an oversized body must be refused
// before any OpenAlex request is made. Case b is the regression guard.
func TestSearchRequestBodyLimit(t *testing.T) {
	tests := []struct {
		name         string
		body         string
		wantStatus   int
		wantUpstream int32
	}{
		{
			name:         "body larger than 16 KiB is rejected with 413 and never reaches upstream",
			body:         `{"query":"` + strings.Repeat("a", 16<<10+1) + `"}`,
			wantStatus:   http.StatusRequestEntityTooLarge,
			wantUpstream: 0,
		},
		{
			name:         "normal small body still succeeds",
			body:         `{"query":"x"}`,
			wantStatus:   http.StatusOK,
			wantUpstream: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var calls int32
			fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				atomic.AddInt32(&calls, 1)
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"results":[],"meta":{"count":0}}`))
			}))
			defer fake.Close()
			t.Setenv("OPENALEX_BASE", fake.URL)

			req := httptest.NewRequest(http.MethodPost, "/api/search", strings.NewReader(tt.body))
			rec := httptest.NewRecorder()
			handleSearch(rec, req)
			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d; body: %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if got := atomic.LoadInt32(&calls); got != tt.wantUpstream {
				t.Errorf("upstream calls = %d, want %d", got, tt.wantUpstream)
			}
		})
	}
}

// TestSearchAPIKeyHandling pins which OPENALEX_API_KEY values reach OpenAlex.
// The .env.example placeholder, an empty value and whitespace-only values are
// "unset": no api_key parameter is sent. A real key is sent trimmed.
func TestSearchAPIKeyHandling(t *testing.T) {
	tests := []struct {
		name        string
		env         string
		wantPresent bool
		wantValue   string
	}{
		{name: "a placeholder is treated as unset", env: "your_key_here", wantPresent: false},
		{name: "a placeholder with surrounding spaces is treated as unset", env: "  your_key_here  ", wantPresent: false},
		{name: "an empty value is unset", env: "", wantPresent: false},
		{name: "a spaces-only value is unset", env: "   ", wantPresent: false},
		{name: "a real key is sent as is", env: "real-key-123", wantPresent: true, wantValue: "real-key-123"},
		{name: "a real key with surrounding spaces is sent trimmed", env: "  real-key-123  ", wantPresent: true, wantValue: "real-key-123"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotPresent bool
			var gotValue string
			fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotPresent = r.URL.Query().Has("api_key")
				gotValue = r.URL.Query().Get("api_key")
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"results":[],"meta":{"count":0}}`))
			}))
			defer fake.Close()
			t.Setenv("OPENALEX_BASE", fake.URL)
			t.Setenv("OPENALEX_API_KEY", tt.env)

			req := httptest.NewRequest(http.MethodPost, "/api/search", strings.NewReader(`{"query":"x"}`))
			rec := httptest.NewRecorder()
			handleSearch(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
			}
			if gotPresent != tt.wantPresent {
				t.Errorf("api_key present = %v (value %q), want present = %v", gotPresent, gotValue, tt.wantPresent)
			}
			if gotValue != tt.wantValue {
				t.Errorf("api_key = %q, want %q", gotValue, tt.wantValue)
			}
		})
	}
}
