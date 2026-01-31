package logging

import (
	"log/slog"
	"os"

	"github.com/Q9Labs/chalk/internal/version"
	axiomslog "github.com/axiomhq/axiom-go/adapters/slog"
)

var handler *axiomslog.Handler
var stdoutLogger *slog.Logger

// Init initializes the global slog logger with environment context.
// If AXIOM_TOKEN is set, logs go to Axiom; otherwise JSON to stdout.
func Init() {
	// Build base attributes for all log events
	attrs := []slog.Attr{
		slog.String("service", "chalk-api"),
		slog.String("version", version.Version),
		slog.String("commit_sha", version.CommitSHA),
		slog.String("env", getEnv("ENV", "development")),
		slog.String("region", getEnv("AWS_REGION", "unknown")),
	}

	// Always have a JSON logger to stdout for CloudWatch and local debugging,
	// even when the default logger is routed to Axiom.
	stdoutHandler := slog.NewJSONHandler(os.Stdout, nil).WithAttrs(attrs)
	stdoutLogger = slog.New(stdoutHandler)

	if os.Getenv("AXIOM_TOKEN") != "" {
		h, err := axiomslog.New()
		if err == nil {
			handler = h
			logger := slog.New(handler).With(attrsToAny(attrs)...)
			slog.SetDefault(logger)
			return
		}
		slog.Error("failed to initialize Axiom handler, falling back to stdout", "error", err)
	}

	// Fallback: JSON to stdout with base attrs
	slog.SetDefault(stdoutLogger)
}

// Close flushes and closes the Axiom handler if initialized.
func Close() {
	if handler != nil {
		handler.Close()
	}
}

// Stdout returns the stdout JSON logger (always initialized by Init()).
// Useful for emitting operational events to CloudWatch even when the default
// logger is routed elsewhere (e.g. Axiom).
func Stdout() *slog.Logger {
	if stdoutLogger == nil {
		return slog.Default()
	}
	return stdoutLogger
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func attrsToAny(attrs []slog.Attr) []any {
	result := make([]any, len(attrs))
	for i, a := range attrs {
		result[i] = a
	}
	return result
}
