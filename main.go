package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
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

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8096"
	}
	if os.Getenv("OPENALEX_API_KEY") == "" {
		log.Print("WARNING: OPENALEX_API_KEY not set — OpenAlex requires an API key since 2026-02-13")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/search", handleSearch)
	mux.HandleFunc("/healthz", handleHealthz)
	mux.HandleFunc("/", handleRoot)

	srv := &http.Server{
		Addr:              "0.0.0.0:" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("nejm-openalex-web on 0.0.0.0:%s", port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, "index.html")
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

// --- OpenAlex API types ---

type openAlexResponse struct {
	Results []openAlexWork `json:"results"`
	Meta    struct {
		Count int `json:"count"`
	} `json:"meta"`
}

type openAlexWork struct {
	ID                     string            `json:"id"`
	DOI                    string            `json:"doi"`
	Title                  string            `json:"title"`
	Type                   string            `json:"type"`
	PublicationYear        int               `json:"publication_year"`
	PublicationDate        string            `json:"publication_date"`
	CitedByCount           int               `json:"cited_by_count"`
	AbstractInvertedIndex  map[string][]int  `json:"abstract_inverted_index"`
	Authorships            []struct {
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
}

// decodeAbstract reconstructs text from OpenAlex inverted index
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
	sort.Slice(all, func(i, j int) bool { return all[i].pos < all[j].pos })
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

// authorsFullStr returns every author, " and "-separated (BibTeX convention).
func authorsFullStr(w openAlexWork) string {
	var names []string
	for _, a := range w.Authorships {
		if a.Author.DisplayName != "" {
			names = append(names, a.Author.DisplayName)
		}
	}
	return strings.Join(names, " and ")
}

// POST /api/search
type searchRequest struct {
	Query    string `json:"query"`
	FromYear int    `json:"from_year,omitempty"`
	ToYear   int    `json:"to_year,omitempty"`
	PerPage  int    `json:"per_page,omitempty"`
	Page     int    `json:"page,omitempty"`
	Sort     string `json:"sort,omitempty"` // "cited" or "date"
}

func handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST", http.StatusMethodNotAllowed)
		return
	}
	var req searchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if req.PerPage <= 0 || req.PerPage > 50 {
		req.PerPage = 20
	}
	if req.Page < 1 {
		req.Page = 1
	}

	// Build OpenAlex filter: NEJM ISSN + optional year range + optional search
	filters := []string{"primary_location.source.issn:" + nejmISSN}
	if req.FromYear > 0 && req.ToYear > 0 {
		filters = append(filters, fmt.Sprintf("publication_year:%d-%d", req.FromYear, req.ToYear))
	} else if req.FromYear > 0 {
		filters = append(filters, fmt.Sprintf("publication_year:%d", req.FromYear))
	}
	// Relevance fix: search ONLY in title + abstract (not full text)
	if req.Query != "" {
		filters = append(filters, "title_and_abstract.search:"+req.Query)
	}

	params := url.Values{}
	params.Set("filter", strings.Join(filters, ","))
	params.Set("per-page", fmt.Sprintf("%d", req.PerPage))
	if req.Page > 1 {
		params.Set("page", strconv.Itoa(req.Page))
	}
	// sort
	if req.Sort == "date" {
		params.Set("sort", "publication_date:desc")
	} else {
		params.Set("sort", "cited_by_count:desc")
	}
	// OpenAlex requires an API key since 2026-02-13 (polite pool retired).
	// Key comes from the environment — never hardcode it (public repo).
	if apiKey := os.Getenv("OPENALEX_API_KEY"); apiKey != "" {
		params.Set("api_key", apiKey)
	}

	// Overridable for tests (point at a mock to exercise the error branch)
	base := os.Getenv("OPENALEX_BASE")
	if base == "" {
		base = "https://api.openalex.org"
	}
	apiURL := base + "/works?" + params.Encode()

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(apiURL)
	if err != nil {
		log.Print(err)
		http.Error(w, "OpenAlex error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, "read error", http.StatusBadGateway)
		return
	}

	// OpenAlex error bodies ({"error":...}) unmarshal cleanly into an empty
	// response, which the UI would show as "No results found." — surface the
	// real failure instead.
	if resp.StatusCode != http.StatusOK {
		snippet := string(body)
		if len(snippet) > 300 {
			snippet = snippet[:300]
		}
		log.Printf("openalex HTTP %d: %s", resp.StatusCode, snippet)
		msg := fmt.Sprintf("OpenAlex error (HTTP %d) — try again shortly", resp.StatusCode)
		if resp.StatusCode == http.StatusConflict {
			msg = "OpenAlex API key missing or quota exceeded (HTTP 409)"
		}
		http.Error(w, msg, http.StatusBadGateway)
		return
	}

	var oaResp openAlexResponse
	if err := json.Unmarshal(body, &oaResp); err != nil {
		log.Print(err)
		http.Error(w, "parse error", http.StatusBadGateway)
		return
	}

	// Convert to clean output
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
			Journal:     wk.PrimaryLocation.Source.DisplayName, // journal name from OpenAlex source
			ArticleType: wk.Type,
			Year:        wk.PublicationYear,
			Date:        wk.PublicationDate,
			DOI:         doi,
			Abstract:    decodeAbstract(wk.AbstractInvertedIndex),
			Citations:   wk.CitedByCount,
			URL:         u,
			IsOA:        wk.OpenAccess.IsOA,
		})
	}

	out := map[string]interface{}{
		"total":    oaResp.Meta.Count,
		"page":     req.Page,
		"articles": articles,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}
