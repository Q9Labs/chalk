package office

import (
	"context"
	"testing"
)

func TestPrecheckFailuresAreMarkedAndKeepTheirCode(t *testing.T) {
	err := Convert(context.Background(), Config{}, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", []byte("x"), t.TempDir(), "out.pdf")
	if err == nil || !IsPrecheckFailure(err.Error()) {
		t.Fatalf("a rejection before any parser ran is not marked as a precheck failure: %v", err)
	}
	if code, ok := CodeFromMessage(err.Error()); !ok || code != CodeUnsupportedFormat {
		t.Fatalf("marked failure lost its code: %q %v", code, ok)
	}
}

func TestParserFailuresAreNotPrecheckFailures(t *testing.T) {
	for _, message := range []string{
		(&Failure{Code: CodeCorrupt, Message: "converter produced no output"}).Error(),
		"isolated office render failed: exit status 1",
		"precheck: not a failure message",
	} {
		if IsPrecheckFailure(message) {
			t.Fatalf("%q was treated as a precheck failure", message)
		}
	}
	if !IsPrecheckFailure("isolated office render failed: " + (&Failure{Code: CodePasswordProtected, Message: "document is password protected", Precheck: true}).Error()) {
		t.Fatal("a wrapped precheck failure was not recognised")
	}
}
