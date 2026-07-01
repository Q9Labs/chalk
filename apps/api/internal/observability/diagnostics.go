package observability

import (
	"io"
	"log/slog"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/postgres/db"
)

type Config struct {
	Pprof     bool
	TraceLogs bool
}

type Diagnostics struct {
	config Config
	logger *slog.Logger
}

func New(config Config, output io.Writer) Diagnostics {
	if output == nil {
		output = io.Discard
	}

	return Diagnostics{
		config: config,
		logger: slog.New(slog.NewJSONHandler(output, nil)),
	}
}

func (d Diagnostics) Queries(next db.Querier) db.Querier {
	if !d.config.TraceLogs {
		return next
	}

	return TraceQueries(next, d.logger)
}

func (d Diagnostics) ApplyHTTP(options *httpapi.Options) {
	if options == nil {
		return
	}
	if d.config.TraceLogs {
		options.Middleware = append(options.Middleware, RequestMiddleware(d.logger))
	}
	if d.config.Pprof {
		options.Debug = DebugHandler()
	}
}
