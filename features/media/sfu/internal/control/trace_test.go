package control

import (
	"net/http/httptest"
	"testing"
)

func TestTraceIDOfReadsOnlyAValidTraceparent(t *testing.T) {
	for name, tc := range map[string]struct{ header, want string }{
		"valid":          {"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", "0af7651916cd43dd8448eb211c80319c"},
		"absent":         {"", ""},
		"all zero id":    {"00-00000000000000000000000000000000-b7ad6b7169203331-01", ""},
		"short id":       {"00-0af7651916cd43dd-b7ad6b7169203331-01", ""},
		"upper case id":  {"00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01", ""},
		"not hex":        {"00-zaf7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", ""},
		"unknown format": {"01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", ""},
		"missing flags":  {"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331", ""},
	} {
		if got := traceIDOf(tc.header); got != tc.want {
			t.Errorf("%s: traceIDOf(%q) = %q, want %q", name, tc.header, got, tc.want)
		}
	}
}

func TestJourneyIDOfKeepsOnlyAnIDShapedValue(t *testing.T) {
	for value, want := range map[string]string{
		"4d0d1c2e-6f2a-4a6b-9b6e-5c1f0f7d9a11": "4d0d1c2e-6f2a-4a6b-9b6e-5c1f0f7d9a11",
		"":                                     "",
		"journey one":                          "",
		"a\nb":                                 "",
		"4d0d1c2e-6f2a-4a6b-9b6e-5c1f0f7d9a11-4d0d1c2e-6f2a-4a6b-9b6e-5c1f0f7d9a11": "",
	} {
		if got := journeyIDOf(value); got != want {
			t.Errorf("journeyIDOf(%q) = %q, want %q", value, got, want)
		}
	}
}

func TestTraceOfReadsBothHeaders(t *testing.T) {
	r := httptest.NewRequest("POST", "/v1/sessions", nil)
	r.Header.Set("traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
	r.Header.Set("x-chalk-journey-id", "4d0d1c2e-6f2a-4a6b-9b6e-5c1f0f7d9a11")
	trace := traceOf(r)
	if trace.TraceID != "0af7651916cd43dd8448eb211c80319c" || trace.JourneyID != "4d0d1c2e-6f2a-4a6b-9b6e-5c1f0f7d9a11" {
		t.Fatalf("trace = %+v", trace)
	}
}
