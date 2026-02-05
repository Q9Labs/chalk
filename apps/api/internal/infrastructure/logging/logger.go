package logging

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"time"

	"github.com/Q9Labs/chalk/internal/version"
	"github.com/axiomhq/axiom-go/axiom"
	axiomslog "github.com/axiomhq/axiom-go/adapters/slog"
)

var handler *axiomslog.Handler
var stdoutLogger *slog.Logger

// Init initializes the global slog logger with environment context.
// If AXIOM_TOKEN is set, logs go to Axiom; otherwise JSON to stdout.
func Init() {
	env := getEnv("ENV", "development")
	if os.Getenv("AXIOM_DATASET") == "" {
		if env == "production" {
			os.Setenv("AXIOM_DATASET", "chalk-api-prod")
		} else {
			os.Setenv("AXIOM_DATASET", "chalk-api")
		}
	}

	// Build base attributes for all log events
	attrs := []slog.Attr{
		slog.String("service", "chalk-api"),
		slog.String("version", version.Version),
		slog.String("commit_sha", version.CommitSHA),
		slog.String("env", env),
		slog.String("region", getEnv("AWS_REGION", "unknown")),
	}

	// Always have a JSON logger to stdout for CloudWatch and local debugging,
	// even when the default logger is routed to Axiom.
	stdoutHandler := slog.NewJSONHandler(os.Stdout, nil).WithAttrs(attrs)
	stdoutLogger = slog.New(stdoutHandler)

	axiomToken := os.Getenv("AXIOM_TOKEN")
	axiomDataset := os.Getenv("AXIOM_DATASET")

	if axiomToken != "" {
		// Guardrail: if the dataset doesn't exist (or token lacks access), don't
		// initialize the Axiom handler. Otherwise the adapter will retry forever
		// and spam stderr with "[AXIOM|SLOG] ... 404: dataset not found".
		//
		// This doesn't fix the underlying Axiom configuration, but it keeps the API
		// usable and makes the failure mode explicit in stdout logs.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		client, err := axiom.NewClient(axiom.SetToken(axiomToken))
		if err == nil {
			_, err = client.Datasets.Get(ctx, axiomDataset)
		}
		if err != nil {
			if errors.Is(err, axiom.ErrNotFound) {
				stdoutLogger.Error("axiom dataset not found; disabling axiom logging", "dataset", axiomDataset, "error", err)
				slog.SetDefault(stdoutLogger)
				return
			}
			if errors.Is(err, axiom.ErrUnauthorized) || errors.Is(err, axiom.ErrUnauthenticated) {
				stdoutLogger.Error("axiom auth failed; disabling axiom logging", "dataset", axiomDataset, "error", err)
				slog.SetDefault(stdoutLogger)
				return
			}
			// Unknown error (network, timeout, etc). Keep stdout only to avoid
			// background retry spam while still surfacing the error once.
			stdoutLogger.Error("axiom init failed; disabling axiom logging", "dataset", axiomDataset, "error", err)
			slog.SetDefault(stdoutLogger)
			return
		}

		h, err := axiomslog.New(axiomslog.SetDataset(axiomDataset))
		if err == nil {
			handler = h
			logger := slog.New(handler).With(attrsToAny(attrs)...)
			slog.SetDefault(logger)
			stdoutLogger.Info("axiom logging enabled", "dataset", axiomDataset)
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
