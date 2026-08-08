package main

import (
	"encoding/json"
	"strings"
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

// TestDecodeAbstractDuplicatePositionIsNotDeterministic pins the fact that two
// words claiming the same position have no defined relative order:
// sort.Slice is not stable, so the surrounding text is guaranteed but the
// ordering of the tied pair is not. This test asserts only what is actually
// guaranteed. Run with -count=20 to exercise the randomisation.
func TestDecodeAbstractDuplicatePositionIsNotDeterministic(t *testing.T) {
	inv := map[string][]int{
		"start": {0},
		"alpha": {1},
		"beta":  {1},
		"end":   {2},
	}

	got := decodeAbstract(inv)

	if !strings.HasPrefix(got, "start ") || !strings.HasSuffix(got, " end") {
		t.Fatalf("decodeAbstract() = %q, want the unambiguous positions to bracket the tie", got)
	}
	middle := strings.TrimSuffix(strings.TrimPrefix(got, "start "), " end")
	if middle != "alpha beta" && middle != "beta alpha" {
		t.Errorf("decodeAbstract() tied words = %q, want the two tied words in some order", middle)
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
