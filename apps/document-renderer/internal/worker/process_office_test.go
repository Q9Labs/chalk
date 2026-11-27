package worker

import (
	"errors"
	"slices"
	"strings"
	"testing"

	controlplane "github.com/q9labs/chalk/apps/document-renderer/internal/control"
	"github.com/q9labs/chalk/apps/document-renderer/internal/office"
)

func TestClassifyIsolatedFailureUsesOfficeCodes(t *testing.T) {
	for _, code := range []string{"password_protected", "corrupt", "too_many_pages", "too_large", "unsupported_format"} {
		err := isolatedChildCompromiseError{err: errors.New("isolated office render failed: office_failure=" + code + ": x wall-clock memory")}
		if got := classifyIsolatedFailure(err); got != code {
			t.Fatalf("classify %s = %s", code, got)
		}
	}
}

func TestOfficeChildEnvironmentCarriesOnlyConverterSettings(t *testing.T) {
	t.Setenv("RENDERER_SOFFICE", "/opt/soffice")
	t.Setenv("RENDERER_KEYNOTE", "1")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	office := isolatedChildEnvironment("office")
	if !slices.Contains(office, "RENDERER_SOFFICE=/opt/soffice") || !slices.Contains(office, "RENDERER_KEYNOTE=1") {
		t.Fatalf("office environment = %v", office)
	}
	for _, item := range office {
		if strings.HasPrefix(item, "AWS_") {
			t.Fatalf("office environment leaks %s", item)
		}
	}
	for _, item := range isolatedChildEnvironment("page") {
		if strings.HasPrefix(item, "RENDERER_SOFFICE") || strings.HasPrefix(item, "RENDERER_KEYNOTE") {
			t.Fatalf("page environment carries converter setting %s", item)
		}
	}
}

func TestLastUploadPage(t *testing.T) {
	uploads := []controlplane.PageUploads{{Page: 3}, {Page: 7}, {Page: 5}}
	if got := lastUploadPage(uploads); got != 7 {
		t.Fatalf("last page = %d", got)
	}
}

func TestEveryOfficeTypeLeavesNoPDFOrImagePath(t *testing.T) {
	for _, mimeType := range office.MIMETypes() {
		if mimeType == "application/pdf" || strings.HasPrefix(mimeType, "image/") {
			t.Fatalf("office table contains %s", mimeType)
		}
	}
}
