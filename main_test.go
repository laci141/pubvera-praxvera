package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
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

// TestSearchBasicPagingLimit pins the OpenAlex basic-paging ceiling: page *
// per_page may not exceed 10,000 (measured: per-page=50 gives HTTP 200 on page
// 200 and HTTP 400 on page 201). Beyond it the handler must answer 400 itself
// rather than forward the request and turn the upstream 400 into a 502.
func TestSearchBasicPagingLimit(t *testing.T) {
	tests := []struct {
		name         string
		body         string
		wantStatus   int
		wantUpstream int32
		wantInBody   string
	}{
		{
			name:         "per_page 50, page 200 is the last allowed page",
			body:         `{"query":"x","per_page":50,"page":200}`,
			wantStatus:   http.StatusOK,
			wantUpstream: 1,
		},
		{
			name:         "per_page 50, page 201 is refused with 400 and never reaches upstream",
			body:         `{"query":"x","per_page":50,"page":201}`,
			wantStatus:   http.StatusBadRequest,
			wantUpstream: 0,
			wantInBody:   "10,000",
		},
		{
			name:         "per_page 20, page 500 is the last allowed page",
			body:         `{"query":"x","per_page":20,"page":500}`,
			wantStatus:   http.StatusOK,
			wantUpstream: 1,
		},
		{
			name:         "per_page 20, page 501 is refused with 400 and never reaches upstream",
			body:         `{"query":"x","per_page":20,"page":501}`,
			wantStatus:   http.StatusBadRequest,
			wantUpstream: 0,
			wantInBody:   "10,000",
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
			if tt.wantInBody != "" && !strings.Contains(rec.Body.String(), tt.wantInBody) {
				t.Errorf("body = %q, want it to mention %q", rec.Body.String(), tt.wantInBody)
			}
		})
	}
}

// TestSearchOpenAlexQuery pins the openalex_query field: the filter and sort
// that were sent upstream, encoded, so the browser can link to the same result
// set on openalex.org. It must never carry the API key, the page or the page
// size, because the browser puts it into links and exported files.
func TestSearchOpenAlexQuery(t *testing.T) {
	var upstreamQuery string
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[],"meta":{"count":13343}}`))
	}))
	defer fake.Close()
	t.Setenv("OPENALEX_BASE", fake.URL)
	t.Setenv("OPENALEX_API_KEY", "real-key-123")

	req := httptest.NewRequest(http.MethodPost, "/api/search",
		strings.NewReader(`{"query":"patients","from_year":1990,"to_year":2026,"per_page":50,"page":3,"sort":"cited"}`))
	rec := httptest.NewRecorder()
	handleSearch(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		OpenAlexQuery string `json:"openalex_query"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	t.Run("a: carries the encoded filter (ISSN, years, query term) and the sort", func(t *testing.T) {
		for _, want := range []string{
			"filter=primary_location.source.issn%3A0028-4793%2Cpublication_year%3A1990-2026%2Ctitle_and_abstract.search%3Apatients",
			"sort=cited_by_count%3Adesc",
		} {
			if !strings.Contains(out.OpenAlexQuery, want) {
				t.Errorf("openalex_query = %q, want it to contain %q", out.OpenAlexQuery, want)
			}
		}
	})

	t.Run("b: carries no api_key, key value, page or per-page", func(t *testing.T) {
		if out.OpenAlexQuery == "" {
			t.Fatal("openalex_query is empty, so the absence checks below would pass vacuously")
		}
		for _, bad := range []string{"api_key", "real-key-123", "page=", "per-page="} {
			if strings.Contains(out.OpenAlexQuery, bad) {
				t.Errorf("openalex_query = %q, must not contain %q", out.OpenAlexQuery, bad)
			}
		}
		if strings.Contains(rec.Body.String(), "real-key-123") {
			t.Errorf("response body leaks the API key: %s", rec.Body.String())
		}
		// Control: the key really was sent upstream, so the checks above bite.
		if !strings.Contains(upstreamQuery, "api_key=real-key-123") {
			t.Errorf("fixture: upstream query %q should carry the api_key", upstreamQuery)
		}
	})
}

// TestSearchYearRangeValidation pins the year checks in handleSearch. A year of
// 0 means "not set" and keeps the old behaviour; any other year must lie in
// [1800, current year + 1] and from_year may not exceed to_year. Every refusal
// must happen before an OpenAlex request is made, so the cases count upstream
// calls.
func TestSearchYearRangeValidation(t *testing.T) {
	now := time.Now().Year()
	tests := []struct {
		name         string
		from, to     int
		wantStatus   int
		wantUpstream int32
		wantInBody   string
	}{
		{name: "a: from_year after to_year is refused", from: 2020, to: 2010, wantStatus: http.StatusBadRequest, wantUpstream: 0, wantInBody: "from_year"},
		{name: "b: from_year 1700 is below the minimum", from: 1700, to: 2020, wantStatus: http.StatusBadRequest, wantUpstream: 0},
		{name: "c: to_year two years ahead is above the maximum", from: 2000, to: now + 2, wantStatus: http.StatusBadRequest, wantUpstream: 0},
		{name: "d: from_year equal to to_year is allowed", from: 2010, to: 2010, wantStatus: http.StatusOK, wantUpstream: 1},
		{name: "e: 1990 to the current year is allowed", from: 1990, to: now, wantStatus: http.StatusOK, wantUpstream: 1},
		{name: "f: both years unset keeps today's behaviour", from: 0, to: 0, wantStatus: http.StatusOK, wantUpstream: 1},
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

			body := fmt.Sprintf(`{"query":"x","from_year":%d,"to_year":%d}`, tt.from, tt.to)
			req := httptest.NewRequest(http.MethodPost, "/api/search", strings.NewReader(body))
			rec := httptest.NewRecorder()
			handleSearch(rec, req)
			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d; body: %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if got := atomic.LoadInt32(&calls); got != tt.wantUpstream {
				t.Errorf("upstream calls = %d, want %d", got, tt.wantUpstream)
			}
			if tt.wantInBody != "" && !strings.Contains(rec.Body.String(), tt.wantInBody) {
				t.Errorf("body = %q, want it to mention %q", rec.Body.String(), tt.wantInBody)
			}
		})
	}
}

func TestCleanSearchQuery(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"a: comma plus space", "heart, failure", "heart failure"},
		{"b: bare comma", "a,b", "a b"},
		{"c: runs of commas and spaces", " a ,, b ", "a b"},
		{"d: only commas", ",,,", ""},
		{"e: no comma is untouched", "no comma", "no comma"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cleanSearchQuery(tt.in); got != tt.want {
				t.Errorf("cleanSearchQuery(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

// TestSearchQueryCommaDoesNotSplitFilter pins that a comma typed by the user
// never reaches the OpenAlex filter value, where it would start a new filter.
// Both the upstream filter and the openalex_query provenance field are checked.
func TestSearchQueryCommaDoesNotSplitFilter(t *testing.T) {
	run := func(t *testing.T, query string) (upstreamFilter, provenance string) {
		t.Helper()
		fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			upstreamFilter = r.URL.Query().Get("filter")
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"results":[],"meta":{"count":0}}`))
		}))
		defer fake.Close()
		t.Setenv("OPENALEX_BASE", fake.URL)
		body, err := json.Marshal(map[string]string{"query": query})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		rec := httptest.NewRecorder()
		handleSearch(rec, httptest.NewRequest(http.MethodPost, "/api/search", strings.NewReader(string(body))))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
		}
		var out struct {
			OpenAlexQuery string `json:"openalex_query"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		return upstreamFilter, out.OpenAlexQuery
	}

	t.Run("a: upstream filter has the cleaned term and the same part count as a comma-free query", func(t *testing.T) {
		got, _ := run(t, "heart, failure")
		ref, _ := run(t, "heart failure")
		if got == "" || ref == "" {
			t.Fatalf("empty upstream filter: got %q, ref %q", got, ref)
		}
		if !strings.Contains(got, "title_and_abstract.search:heart failure") {
			t.Errorf("filter = %q, want it to contain %q", got, "title_and_abstract.search:heart failure")
		}
		if g, r := len(strings.Split(got, ",")), len(strings.Split(ref, ",")); g != r {
			t.Errorf("filter %q has %d comma parts, want %d (same as %q)", got, g, r, ref)
		}
	})

	t.Run("b: openalex_query carries the cleaned term, not the comma", func(t *testing.T) {
		_, prov := run(t, "heart, failure")
		if prov == "" {
			t.Fatal("openalex_query is empty, so the checks below would pass vacuously")
		}
		if !strings.Contains(prov, "title_and_abstract.search%3Aheart+failure") {
			t.Errorf("openalex_query = %q, want it to contain the cleaned term", prov)
		}
		if strings.Contains(prov, "heart%2C") {
			t.Errorf("openalex_query = %q still carries the user's comma", prov)
		}
	})

	t.Run("c: a query of only commas behaves like an empty query", func(t *testing.T) {
		got, prov := run(t, ",,,")
		ref, refProv := run(t, "")
		if ref == "" || refProv == "" {
			t.Fatal("empty-query reference is empty")
		}
		if got != ref || prov != refProv {
			t.Errorf("commas-only: filter %q / provenance %q, want %q / %q", got, prov, ref, refProv)
		}
		if strings.Contains(got, "title_and_abstract") {
			t.Errorf("filter = %q, must not contain a search filter", got)
		}
	})
}
