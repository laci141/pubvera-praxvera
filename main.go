package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// NEJM ISSNs in OpenAlex
const nejmISSN = "0028-4793"

// openAlexTimeout bounds the one outbound call this app makes. It was written
// inline at the call site; naming it here is what lets srvWriteTimeout below be
// derived from it rather than guessed.
const openAlexTimeout = 30 * time.Second

// maxRequestBody caps the /api/search body. A legitimate request is under 1 KiB;
// ReadTimeout limits time, not size.
const maxRequestBody = 16 << 10

// maxBasicResults is OpenAlex's basic-paging ceiling: page * per-page may not
// exceed it (measured: per-page=50 answers 200 on page 200 and 400 on page 201).
const maxBasicResults = 10000

// maxPerPage is the largest page size the search accepts; anything above it
// (or <= 0) falls back to 20.
const maxPerPage = 100

// minYear is the earliest year the search accepts. The latest is the current
// year plus one (an issue can be dated ahead of the calendar year).
const minYear = 1800

// Server-side timeouts. ReadHeaderTimeout was the only one set, which left the
// request BODY with no deadline at all: a size limit is not a time limit, and a
// client that sends its body one byte per minute holds a handler goroutine for
// as long as it likes. Caddy fronts this app in production and sets no request
// timeout of its own, so this is the only place the limit exists.
//
// WriteTimeout is the one that must not be guessed. Unlike the CLI-backed apps
// in this suite, the longest legitimate operation here is the single OpenAlex
// request, so the budget is openAlexTimeout rather than a CLI run: copying the
// 150s used elsewhere would be a number with nothing behind it.
const (
	srvReadHeaderTimeout = 10 * time.Second
	// The body is a small JSON object. Thirty seconds is far more than a real
	// client needs and far less than a slow-loris attacker wants.
	srvReadTimeout = 30 * time.Second
	// The full OpenAlex budget plus room to decode and write the response.
	srvWriteTimeout = openAlexTimeout + 30*time.Second
	// Keep-alive connections that go quiet are released rather than held.
	srvIdleTimeout = 120 * time.Second
)

// apiKeyPlaceholder is the value .env.example ships with. It is not a real key.
const apiKeyPlaceholder = "your_key_here"

// openAlexAPIKey returns the configured OpenAlex key, or "" when the variable is
// empty, whitespace-only or still the .env.example placeholder.
func openAlexAPIKey() string {
	key := strings.TrimSpace(os.Getenv("OPENALEX_API_KEY"))
	if key == apiKeyPlaceholder {
		return ""
	}
	return key
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8096"
	}
	if openAlexAPIKey() == "" {
		log.Print("WARNING: OPENALEX_API_KEY not set — using the lower anonymous OpenAlex budget")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/search", handleSearch)
	mux.HandleFunc("/healthz", handleHealthz)
	mux.HandleFunc("/", handleRoot)

	srv := &http.Server{
		Addr:              "0.0.0.0:" + port,
		Handler:           mux,
		ReadHeaderTimeout: srvReadHeaderTimeout,
		ReadTimeout:       srvReadTimeout,
		WriteTimeout:      srvWriteTimeout,
		IdleTimeout:       srvIdleTimeout,
	}

	log.Printf("nejm-openalex-web on 0.0.0.0:%s", port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

type browserConfig struct {
	SupabaseURL     string `json:"supabase_url"`
	SupabaseAnonKey string `json:"supabase_anon_key"`
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/config.json":
		supaURL := strings.TrimSpace(os.Getenv("SUPABASE_URL"))
		supaKey := strings.TrimSpace(os.Getenv("SUPABASE_PUBLISHABLE_KEY"))
		if supaURL == "" || supaKey == "" {
			supaURL, supaKey = "", ""
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(browserConfig{SupabaseURL: supaURL, SupabaseAnonKey: supaKey})
	case "/":
		http.ServeFile(w, r, "index.html")
	default:
		http.NotFound(w, r)
	}
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

type openAlexResponse struct {
	Results []openAlexWork `json:"results"`
	Meta    struct {
		Count int `json:"count"`
	} `json:"meta"`
}

type openAlexWork struct {
	ID                    string           `json:"id"`
	DOI                   string           `json:"doi"`
	Title                 string           `json:"title"`
	Type                  string           `json:"type"`
	PublicationYear       int              `json:"publication_year"`
	PublicationDate       string           `json:"publication_date"`
	CitedByCount          int              `json:"cited_by_count"`
	IsRetracted           bool             `json:"is_retracted"`
	AbstractInvertedIndex map[string][]int `json:"abstract_inverted_index"`
	Authorships           []struct {
		Author struct {
			DisplayName string `json:"display_name"`
		} `json:"author"`
	} `json:"authorships"`
	PrimaryLocation struct {
		LandingPageURL string `json:"landing_page_url"`
		Source         struct {
			DisplayName string `json:"display_name"`
		} `json:"source"`
	} `json:"primary_location"`
	OpenAccess struct {
		IsOA bool `json:"is_oa"`
	} `json:"open_access"`
}

// --- our clean output ---

type article struct {
	Title       string `json:"title"`
	Authors     string `json:"authors"`
	AuthorsFull string `json:"authors_full"`
	Journal     string `json:"journal"`
	ArticleType string `json:"article_type"`
	Year        int    `json:"year"`
	Date        string `json:"date"`
	DOI         string `json:"doi"`
	Abstract    string `json:"abstract"`
	Citations   int    `json:"citations"`
	URL         string `json:"url"`
	IsOA        bool   `json:"is_oa"`
	// IsRetracted is OpenAlex's own is_retracted field (Retraction Watch
	// based), not a guess from the title. It lets consumers filter or flag
	// retracted papers without parsing the title.
	IsRetracted bool `json:"is_retracted"`
}

func decodeAbstract(inv map[string][]int) string {
	if len(inv) == 0 {
		return ""
	}
	type wp struct {
		word string
		pos  int
	}
	var all []wp
	for word, positions := range inv {
		for _, p := range positions {
			all = append(all, wp{word, p})
		}
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].pos != all[j].pos {
			return all[i].pos < all[j].pos
		}
		return all[i].word < all[j].word
	})
	var sb strings.Builder
	for i, w := range all {
		if i > 0 {
			sb.WriteString(" ")
		}
		sb.WriteString(w.word)
	}
	return sb.String()
}

func authorsStr(w openAlexWork) string {
	var names []string
	for _, a := range w.Authorships {
		if a.Author.DisplayName != "" {
			names = append(names, a.Author.DisplayName)
		}
	}
	if len(names) > 4 {
		return strings.Join(names[:4], ", ") + " et al."
	}
	return strings.Join(names, ", ")
}

func authorsFullStr(w openAlexWork) string {
	var names []string
	for _, a := range w.Authorships {
		if a.Author.DisplayName != "" {
			names = append(names, a.Author.DisplayName)
		}
	}
	return strings.Join(names, " and ")
}

type searchRequest struct {
	Query    string `json:"query"`
	FromYear int    `json:"from_year,omitempty"`
	ToYear   int    `json:"to_year,omitempty"`
	PerPage  int    `json:"per_page,omitempty"`
	Page     int    `json:"page,omitempty"`
	Sort     string `json:"sort,omitempty"`
}

type searchResponse struct {
	Total    int       `json:"total"`
	Page     int       `json:"page"`
	Articles []article `json:"articles"`
	// OpenAlexQuery is the encoded filter and sort of this search (no api_key,
	// page or per-page), so the browser can link to the same result set.
	OpenAlexQuery string `json:"openalex_query"`
}

// cleanSearchQuery makes a user query safe to place inside the OpenAlex filter
// value. A comma separates filters there, so every comma becomes a space; runs
// of whitespace are then collapsed and the ends trimmed. Nothing else changes.
func cleanSearchQuery(q string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(q, ",", " ")), " ")
}

// writeJSONError answers with {"error": msg}, the shape the UI shows for 5xx.
func writeJSONError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// upstreamError maps a non-200 OpenAlex status to the status and message this
// server answers with. A 429 becomes 503 with a Retry-After: the upstream value
// when it is whole seconds in 1..300, else 30. The message never carries the
// URL or the API key.
func upstreamError(status int, retryAfter string) (code int, msg string, retryAfterOut string) {
	switch {
	case status == http.StatusTooManyRequests:
		n := 30
		if v, err := strconv.Atoi(retryAfter); err == nil && v >= 1 && v <= 300 {
			n = v
		}
		return http.StatusServiceUnavailable, fmt.Sprintf("OpenAlex rate limit reached — try again in %d seconds", n), strconv.Itoa(n)
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return http.StatusBadGateway, "OpenAlex rejected the server's credentials — this is a configuration problem", ""
	case status == http.StatusConflict:
		return http.StatusBadGateway, "OpenAlex API key missing or quota exceeded (HTTP 409)", ""
	case status >= 500:
		return http.StatusBadGateway, "OpenAlex is temporarily unavailable — try again shortly", ""
	default:
		return http.StatusBadGateway, fmt.Sprintf("OpenAlex rejected the request (HTTP %d)", status), ""
	}
}

// transportError classifies a failed OpenAlex call: a timeout is 504, anything
// else 502. The error itself is only logged, since it carries the request URL.
func transportError(err error) (code int, msg string) {
	var ne net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
		return http.StatusGatewayTimeout, "OpenAlex did not respond in time — try again shortly"
	}
	return http.StatusBadGateway, "Could not reach OpenAlex — try again shortly"
}

func handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
	var req searchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if req.PerPage <= 0 || req.PerPage > maxPerPage {
		req.PerPage = 20
	}
	if req.Page < 1 {
		req.Page = 1
	}
	if req.Page > maxBasicResults/req.PerPage {
		http.Error(w, "page beyond the OpenAlex 10,000-result paging limit — refine the search", http.StatusBadRequest)
		return
	}

	// A year of 0 means "not set" and is not checked.
	maxYear := time.Now().Year() + 1
	for _, y := range []int{req.FromYear, req.ToYear} {
		if y != 0 && (y < minYear || y > maxYear) {
			http.Error(w, fmt.Sprintf("year out of range (%d to %d)", minYear, maxYear), http.StatusBadRequest)
			return
		}
	}
	if req.FromYear != 0 && req.ToYear != 0 && req.FromYear > req.ToYear {
		http.Error(w, "from_year must not be greater than to_year", http.StatusBadRequest)
		return
	}

	filters := []string{"primary_location.source.issn:" + nejmISSN}
	if req.FromYear > 0 && req.ToYear > 0 {
		filters = append(filters, fmt.Sprintf("publication_year:%d-%d", req.FromYear, req.ToYear))
	} else if req.FromYear > 0 {
		filters = append(filters, fmt.Sprintf("publication_year:%d", req.FromYear))
	}
	if query := cleanSearchQuery(req.Query); query != "" {
		filters = append(filters, "title_and_abstract.search:"+query)
	}

	sortBy := "cited_by_count:desc"
	if req.Sort == "date" {
		sortBy = "publication_date:desc"
	}
	// The same filter and sort that are sent upstream, and nothing else: the
	// browser turns this into openalex.org links, so it must never carry the
	// api_key, the page or the page size.
	shared := url.Values{}
	shared.Set("filter", strings.Join(filters, ","))
	shared.Set("sort", sortBy)

	params := url.Values{}
	params.Set("filter", strings.Join(filters, ","))
	params.Set("per-page", fmt.Sprintf("%d", req.PerPage))
	if req.Page > 1 {
		params.Set("page", strconv.Itoa(req.Page))
	}
	params.Set("sort", sortBy)
	if apiKey := openAlexAPIKey(); apiKey != "" {
		params.Set("api_key", apiKey)
	}

	base := os.Getenv("OPENALEX_BASE")
	if base == "" {
		base = "https://api.openalex.org"
	}
	apiURL := base + "/works?" + params.Encode()

	client := &http.Client{Timeout: openAlexTimeout}
	resp, err := client.Get(apiURL)
	if err != nil {
		log.Print(err)
		code, msg := transportError(err)
		writeJSONError(w, code, msg)
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "read error")
		return
	}

	if resp.StatusCode != http.StatusOK {
		snippet := string(body)
		if len(snippet) > 300 {
			snippet = snippet[:300]
		}
		log.Printf("openalex HTTP %d: %s", resp.StatusCode, snippet)
		code, msg, retryAfter := upstreamError(resp.StatusCode, resp.Header.Get("Retry-After"))
		if retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		writeJSONError(w, code, msg)
		return
	}

	var oaResp openAlexResponse
	if err := json.Unmarshal(body, &oaResp); err != nil {
		log.Print(err)
		writeJSONError(w, http.StatusBadGateway, "parse error")
		return
	}

	articles := make([]article, 0, len(oaResp.Results))
	for _, wk := range oaResp.Results {
		doi := strings.TrimPrefix(wk.DOI, "https://doi.org/")
		u := wk.PrimaryLocation.LandingPageURL
		if u == "" && doi != "" {
			u = "https://doi.org/" + doi
		}
		articles = append(articles, article{
			Title:       wk.Title,
			Authors:     authorsStr(wk),
			AuthorsFull: authorsFullStr(wk),
			Journal:     wk.PrimaryLocation.Source.DisplayName,
			ArticleType: wk.Type,
			Year:        wk.PublicationYear,
			Date:        wk.PublicationDate,
			DOI:         doi,
			Abstract:    decodeAbstract(wk.AbstractInvertedIndex),
			Citations:   wk.CitedByCount,
			URL:         u,
			IsOA:        wk.OpenAccess.IsOA,
			IsRetracted: wk.IsRetracted,
		})
	}

	out := searchResponse{
		Total:         oaResp.Meta.Count,
		Page:          req.Page,
		Articles:      articles,
		OpenAlexQuery: shared.Encode(),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}
