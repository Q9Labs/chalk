package observability_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func TestLoggerAddsStableCommonFields(t *testing.T) {
	var logs bytes.Buffer
	diagnostics := observability.New(observability.Config{
		Environment: "test",
		LogFormat:   observability.LogFormatJSON,
		LogLevel:    "info",
		Service:     "chalk-api-test",
		Version:     "v1",
	}, &logs)

	diagnostics.Logger().Info("hello", "event", "test.event")

	log := logs.String()
	for _, want := range []string{
		`"service":"chalk-api-test"`,
		`"env":"test"`,
		`"version":"v1"`,
		`"event":"test.event"`,
	} {
		if !strings.Contains(log, want) {
			t.Fatalf("log = %s, want %s", log, want)
		}
	}
}
