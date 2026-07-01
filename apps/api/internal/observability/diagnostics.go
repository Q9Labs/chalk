package observability

import (
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/postgres/db"
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
	OperationLogs        bool
	Profiler             bool
	RequestLogs          RequestLogMode
	RequestSampleRate    float64
	Service              string
	SlowRequestThreshold time.Duration
	Version              string
}

type Diagnostics struct {
	config Config
	logger *slog.Logger
}

func New(config Config, output io.Writer) Diagnostics {
	if output == nil {
		output = io.Discard
	}

	handlerOptions := &slog.HandlerOptions{
		Level: parseLogLevel(config.LogLevel),
	}
	var handler slog.Handler
	if config.LogFormat == LogFormatText {
		handler = slog.NewTextHandler(output, handlerOptions)
	} else {
		handler = slog.NewJSONHandler(output, handlerOptions)
	}

	logger := slog.New(handler).With(
		"service", valueOrDefault(config.Service, "chalk-api"),
		"env", valueOrDefault(config.Environment, "local"),
		"version", valueOrDefault(config.Version, "dev"),
	)

	return Diagnostics{
		config: config,
		logger: logger,
	}
}

// TODO: If we adopt OpenTelemetry, enrich this boundary with trace/span fields
// without leaking OTel types into handlers, services, or repositories.
func (d Diagnostics) Logger() *slog.Logger {
	return d.logger
}

func (d Diagnostics) Queries(next db.Querier) db.Querier {
	if !d.config.OperationLogs {
		return next
	}

	return OperationQueries(next, d.logger)
}

func (d Diagnostics) ApplyHTTP(options *httpapi.Options) {
	if options == nil {
		return
	}
	if d.config.RequestLogs != RequestLogOff {
		options.Middleware = append(options.Middleware, RequestMiddleware(d.logger, RequestLogConfig{
			Mode:          d.config.RequestLogs,
			SampleRate:    d.config.RequestSampleRate,
			SlowThreshold: d.config.SlowRequestThreshold,
		}))
	}
	if d.config.Profiler {
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
