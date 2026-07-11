package observability

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"go.opentelemetry.io/contrib/bridges/otelslog"
)

type LogFormat string

const (
	LogFormatJSON LogFormat = "json"
	LogFormatText LogFormat = "text"
)

type RequestLogMode string

const (
	RequestLogOff     RequestLogMode = "off"
	RequestLogErrors  RequestLogMode = "errors"
	RequestLogSlow    RequestLogMode = "slow"
	RequestLogSampled RequestLogMode = "sampled"
	RequestLogAll     RequestLogMode = "all"
)

type Config struct {
	Environment          string
	LogFormat            LogFormat
	LogLevel             string
	OTLPEndpoint         string
	OTLPInsecure         bool
	OperationLogs        bool
	Profiler             bool
	RequestLogs          RequestLogMode
	RequestSampleRate    float64
	Service              string
	SlowRequestThreshold time.Duration
	Version              string
}

type Diagnostics struct {
	config  Config
	logger  *slog.Logger
	metrics JourneyMetrics
}

func New(config Config, output io.Writer) Diagnostics {
	if output == nil {
		output = io.Discard
	}

	logLevel := parseLogLevel(config.LogLevel)
	handlerOptions := &slog.HandlerOptions{
		Level: logLevel,
	}
	var handler slog.Handler
	if config.LogFormat == LogFormatText {
		handler = slog.NewTextHandler(output, handlerOptions)
	} else {
		handler = slog.NewJSONHandler(output, handlerOptions)
	}
	if strings.TrimSpace(config.OTLPEndpoint) != "" {
		handler = fanoutHandler{handlers: []slog.Handler{
			handler,
			otelslog.NewHandler("github.com/q9labs/chalk/apps/api", otelslog.WithVersion(valueOrDefault(config.Version, "dev"))),
		}}
	}
	handler = logLevelHandler{next: handler, level: logLevel}

	logger := slog.New(correlationHandler{next: handler}).With(
		"service", valueOrDefault(config.Service, "chalk-api"),
		"env", valueOrDefault(config.Environment, "local"),
		"version", valueOrDefault(config.Version, "dev"),
	)

	return Diagnostics{
		config:  config,
		logger:  logger,
		metrics: NewJourneyMetrics(),
	}
}

type fanoutHandler struct {
	handlers []slog.Handler
}

func (h fanoutHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, handler := range h.handlers {
		if handler.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (h fanoutHandler) Handle(ctx context.Context, record slog.Record) error {
	for _, handler := range h.handlers {
		if handler.Enabled(ctx, record.Level) {
			if err := handler.Handle(ctx, record.Clone()); err != nil {
				return err
			}
		}
	}
	return nil
}

func (h fanoutHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	handlers := make([]slog.Handler, 0, len(h.handlers))
	for _, handler := range h.handlers {
		handlers = append(handlers, handler.WithAttrs(attrs))
	}
	return fanoutHandler{handlers: handlers}
}

func (h fanoutHandler) WithGroup(name string) slog.Handler {
	handlers := make([]slog.Handler, 0, len(h.handlers))
	for _, handler := range h.handlers {
		handlers = append(handlers, handler.WithGroup(name))
	}
	return fanoutHandler{handlers: handlers}
}

func (d Diagnostics) Logger() *slog.Logger {
	return d.logger
}

func (d Diagnostics) JourneyMetrics() JourneyMetrics {
	return d.metrics
}

func (d Diagnostics) Queries(next sqlc.Querier) sqlc.Querier {
	logger := d.logger
	if !d.config.OperationLogs {
		logger = nil
	}
	return OperationQueries(next, logger)
}

func (d Diagnostics) ApplyHTTP(options *httpapi.Options) {
	if options == nil {
		return
	}
	options.Middleware = append(options.Middleware, OTelHTTPMiddleware(), JourneyMiddleware)
	options.JourneyMetrics = d.metrics
	if d.config.RequestLogs != RequestLogOff {
		options.Middleware = append(options.Middleware, RequestMiddleware(d.logger, RequestLogConfig{
			Mode:          d.config.RequestLogs,
			SampleRate:    d.config.RequestSampleRate,
			SlowThreshold: d.config.SlowRequestThreshold,
		}))
	}
	if d.config.Profiler && d.config.Environment == "local" {
		options.Profiler = ProfilerHandler()
	}
}

func parseLogLevel(value string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func valueOrDefault(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
