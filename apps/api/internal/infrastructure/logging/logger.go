package logging

import (
	"log/slog"
	"os"

	axiomslog "github.com/axiomhq/axiom-go/adapters/slog"
)

var handler *axiomslog.Handler

func Init() {
	if os.Getenv("AXIOM_TOKEN") != "" {
		h, err := axiomslog.New()
		if err == nil {
			handler = h
			slog.SetDefault(slog.New(handler))
			return
		}
		// Log fallback reason to stderr before switching handlers
		slog.Error("failed to initialize Axiom handler, falling back to stdout", "error", err)
	}
	// Fallback: JSON to stdout
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
}

func Close() {
	if handler != nil {
		handler.Close()
	}
}
