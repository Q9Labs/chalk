package presenting

import (
	"slices"
	"testing"
)

func TestFormatFlagsGateMIMETypes(t *testing.T) {
	const pptx = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
	const keynote = "application/vnd.apple.keynote"
	for _, tc := range []struct {
		name    string
		flags   FormatFlags
		mime    string
		allowed bool
	}{
		{"pdf with no flags", FormatFlags{}, "application/pdf", true},
		{"image with no flags", FormatFlags{}, "image/webp", true},
		{"pptx with no flags", FormatFlags{}, pptx, false},
		{"text with no flags", FormatFlags{}, "text/plain", false},
		{"pptx with office", FormatFlags{Office: true}, pptx, true},
		{"text with office", FormatFlags{Office: true}, "text/plain", true},
		{"keynote with office only", FormatFlags{Office: true}, keynote, false},
		{"keynote with keynote only", FormatFlags{Keynote: true}, keynote, false},
		{"keynote with both", FormatFlags{Office: true, Keynote: true}, keynote, true},
		{"iwork keynote with both", FormatFlags{Office: true, Keynote: true}, "application/x-iwork-keynote-sffkey", true},
		{"unknown type", FormatFlags{Office: true, Keynote: true}, "application/zip", false},
		{"empty type", FormatFlags{Office: true, Keynote: true}, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.flags.AcceptsMIMEType(tc.mime); got != tc.allowed {
				t.Fatalf("AcceptsMIMEType(%q) = %t, want %t", tc.mime, got, tc.allowed)
			}
		})
	}
}

func TestAcceptedFormatIDs(t *testing.T) {
	core := FormatFlags{}.AcceptedFormatIDs()
	if !slices.Equal(core, []string{"pdf", "png", "jpeg", "gif", "webp"}) {
		t.Fatalf("core formats = %v", core)
	}
	office := FormatFlags{Office: true}.AcceptedFormatIDs()
	if slices.Contains(office, "key") || !slices.Contains(office, "xlsx") {
		t.Fatalf("office formats = %v", office)
	}
	if !slices.Contains(FormatFlags{Office: true, Keynote: true}.AcceptedFormatIDs(), "key") {
		t.Fatal("keynote missing when both flags are on")
	}
}

func TestFailureMessages(t *testing.T) {
	for _, code := range []string{"password_protected", "corrupt", "too_many_pages", "too_large", "unsupported_format"} {
		if FailureMessage(code, "") == "" {
			t.Fatalf("failure %q has no message", code)
		}
	}
	if got := FailureMessage("something_new", "stored"); got != "stored" {
		t.Fatalf("unknown code message = %q", got)
	}
}
