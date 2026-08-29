package tenants

import (
	"encoding/json"
	"errors"
	"slices"
	"testing"
)

func TestCORSOriginsCanonicalizesDeduplicatesAndSorts(t *testing.T) {
	origins, err := CORSOrigins([]string{
		" HTTPS://Example.COM:443 ",
		"http://localhost:3070",
		"https://example.com",
		"http://[::1]:8080",
	})
	if err != nil {
		t.Fatalf("CORSOrigins returned an error: %v", err)
	}
	want := []string{"http://[::1]:8080", "http://localhost:3070", "https://example.com"}
	if !slices.Equal(origins, want) {
		t.Fatalf("CORSOrigins = %#v, want %#v", origins, want)
	}
}

func TestCORSOriginRejectsUnsafeOrInexactValues(t *testing.T) {
	values := []string{
		"",
		"*",
		"https://*.example.com",
		"http://example.com",
		"https://example.com/path",
		"https://example.com?query=1",
		"https://user@example.com",
		"https://bücher.example",
		"ftp://example.com",
		"null",
	}
	for _, value := range values {
		t.Run(value, func(t *testing.T) {
			if _, err := CORSOrigin(value); !errors.Is(err, ErrInvalidCORSOrigin) {
				t.Fatalf("CORSOrigin(%q) error = %v, want %v", value, err, ErrInvalidCORSOrigin)
			}
		})
	}
}

func TestCORSOriginsRejectsMoreThanMaximum(t *testing.T) {
	values := make([]string, MaxCORSOrigins+1)
	for index := range values {
		values[index] = "https://app" + string(rune('a'+index)) + ".example"
	}
	if _, err := CORSOrigins(values); !errors.Is(err, ErrInvalidCORSOrigin) {
		t.Fatalf("CORSOrigins error = %v, want %v", err, ErrInvalidCORSOrigin)
	}
}

func TestOptionalCORSOriginsRejectsNull(t *testing.T) {
	var origins OptionalCORSOrigins
	if err := json.Unmarshal([]byte("null"), &origins); !errors.Is(err, ErrInvalidCORSOrigin) {
		t.Fatalf("Unmarshal error = %v, want %v", err, ErrInvalidCORSOrigin)
	}
}
