package tenants

import "testing"

func TestCORSOriginCanonicalizesLikeABrowser(t *testing.T) {
	valid := map[string]string{
		"https://Example.COM":        "https://example.com",
		" https://example.com ":      "https://example.com",
		"https://example.com:443":    "https://example.com",
		"https://example.com:8443":   "https://example.com:8443",
		"http://localhost":           "http://localhost",
		"http://localhost:80":        "http://localhost",
		"http://localhost:3000":      "http://localhost:3000",
		"http://127.0.0.1:5173":      "http://127.0.0.1:5173",
		"http://0x7f.1":              "http://127.0.0.1",
		"http://2130706433":          "http://127.0.0.1",
		"http://[::1]:3000":          "http://[::1]:3000",
		"http://[::1]":               "http://[::1]",
		"https://[2001:db8::1]:9000": "https://[2001:db8::1]:9000",
	}
	for input, want := range valid {
		got, err := CORSOrigin(input)
		if err != nil || got != want {
			t.Errorf("CORSOrigin(%q) = %q, %v; want %q", input, got, err, want)
		}
	}

	invalid := []string{
		"",
		"*",
		"https://*.example.com",
		"https://example.com/path",
		"https://example.com/",
		"https://example.com?x=1",
		"https://example.com#frag",
		"https://user@example.com",
		"ftp://example.com",
		"http://example.com",
		"http://192.168.0.1",
		"https://exämple.com",
		"https://example.com:99999",
		"https://example.com:abc",
		"http://256.1.1.1",
		"example.com",
		"mailto:a@example.com",
	}
	for _, input := range invalid {
		if got, err := CORSOrigin(input); err == nil {
			t.Errorf("CORSOrigin(%q) = %q; want an error", input, got)
		}
	}
}

func TestCORSOriginsDeduplicatesSortsAndBounds(t *testing.T) {
	got, err := CORSOrigins([]string{"https://b.example", "https://a.example", "https://B.example"})
	if err != nil || len(got) != 2 || got[0] != "https://a.example" || got[1] != "https://b.example" {
		t.Fatalf("CORSOrigins = %v, %v", got, err)
	}
	tooMany := make([]string, MaxCORSOrigins+1)
	for index := range tooMany {
		tooMany[index] = "https://example.com"
	}
	if _, err := CORSOrigins(tooMany); err == nil {
		t.Fatal("CORSOrigins accepted more than the maximum")
	}
}
