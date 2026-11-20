package config

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	APIEnvironment           = "CHALK_API_ENV"
	APILogFormat             = "CHALK_API_LOG_FORMAT"
	APILogLevel              = "CHALK_API_LOG_LEVEL"
	APIOTLPEndpoint          = "CHALK_API_OTLP_ENDPOINT"
	APIOTLPInsecure          = "CHALK_API_OTLP_INSECURE"
	APIOperationLogs         = "CHALK_API_OPERATION_LOGS"
	APIProfiler              = "CHALK_API_PROFILER"
	APIRequestLogs           = "CHALK_API_REQUEST_LOGS"
	APIRequestSampleRate     = "CHALK_API_REQUEST_SAMPLE_RATE"
	APIService               = "CHALK_API_SERVICE"
	APISlowRequestMS         = "CHALK_API_SLOW_REQUEST_MS"
	APIVersion               = "CHALK_API_VERSION"
	DefaultEnvironment       = "local"
	DefaultLogFormat         = "json"
	DefaultLogLevel          = "info"
	DefaultRequestLogs       = "off"
	DefaultRequestSampleRate = 0.01
	DefaultServiceName       = "chalk-api"
	DefaultSlowRequestMS     = int64(250)
	DefaultVersion           = "dev"
)

type ObservabilityConfig struct {
	Environment          string
	LogFormat            string
	LogLevel             string
	OTLPEndpoint         string
	OTLPInsecure         bool
	OperationLogs        bool
	Profiler             bool
	RequestLogs          string
	RequestSampleRate    float64
	Service              string
	SlowRequestThreshold time.Duration
	Version              string
}

func loadObservability(environment string) (ObservabilityConfig, error) {
	logFormat, err := envEnum(APILogFormat, DefaultLogFormat, "json", "text")
	if err != nil {
		return ObservabilityConfig{}, err
	}
	logLevel, err := envEnum(APILogLevel, DefaultLogLevel, "debug", "info", "warn", "error")
	if err != nil {
		return ObservabilityConfig{}, err
	}
	otlpEndpoint := strings.TrimSpace(envOrDefault(APIOTLPEndpoint, ""))
	otlpInsecure := envBool(APIOTLPInsecure)
	if err := validateOTLPEndpoint(environment, otlpEndpoint, otlpInsecure); err != nil {
		return ObservabilityConfig{}, err
	}
	operationLogs := envBool(APIOperationLogs)
	requestLogs, err := envRequestLogs(operationLogs)
	if err != nil {
		return ObservabilityConfig{}, err
	}
	requestSampleRate, err := envFloat64(APIRequestSampleRate, DefaultRequestSampleRate)
	if err != nil {
		return ObservabilityConfig{}, err
	}
	if requestSampleRate < 0 || requestSampleRate > 1 {
		return ObservabilityConfig{}, fmt.Errorf("%s must be between 0 and 1", APIRequestSampleRate)
	}
	slowRequestThreshold, err := envMilliseconds(APISlowRequestMS, DefaultSlowRequestMS)
	if err != nil {
		return ObservabilityConfig{}, err
	}
	if slowRequestThreshold < 0 {
		return ObservabilityConfig{}, fmt.Errorf("%s must be non-negative", APISlowRequestMS)
	}
	return ObservabilityConfig{
		Environment:          environment,
		LogFormat:            logFormat,
		LogLevel:             logLevel,
		OTLPEndpoint:         otlpEndpoint,
		OTLPInsecure:         otlpInsecure,
		OperationLogs:        operationLogs,
		Profiler:             envBool(APIProfiler),
		RequestLogs:          requestLogs,
		RequestSampleRate:    requestSampleRate,
		Service:              envOrDefault(APIService, DefaultServiceName),
		SlowRequestThreshold: slowRequestThreshold,
		Version:              envOrDefault(APIVersion, DefaultVersion),
	}, nil
}

func validateOTLPEndpoint(environment string, endpoint string, insecure bool) error {
	if endpoint == "" {
		if insecure {
			return fmt.Errorf("%s requires %s", APIOTLPInsecure, APIOTLPEndpoint)
		}
		return nil
	}
	if insecure && environment != DefaultEnvironment {
		return fmt.Errorf("%s is only supported in local environments", APIOTLPInsecure)
	}

	parsed, err := url.Parse(endpoint)
	if err != nil {
		return fmt.Errorf("%s must be a valid URL: %w", APIOTLPEndpoint, err)
	}
	if parsed.Scheme == "" || parsed.Host == "" || parsed.Path != "" && parsed.Path != "/" {
		return fmt.Errorf("%s must be an absolute base URL without a path", APIOTLPEndpoint)
	}
	if insecure {
		if parsed.Scheme != "http" {
			return fmt.Errorf("%s must use http when %s is enabled", APIOTLPEndpoint, APIOTLPInsecure)
		}
		return nil
	}
	if parsed.Scheme != "https" {
		return fmt.Errorf("%s must use https unless %s is enabled locally", APIOTLPEndpoint, APIOTLPInsecure)
	}
	return nil
}

func envRequestLogs(operationLogs bool) (string, error) {
	value, ok := os.LookupEnv(APIRequestLogs)
	if !ok || value == "" {
		if operationLogs {
			return "all", nil
		}
		return DefaultRequestLogs, nil
	}

	return envEnum(APIRequestLogs, DefaultRequestLogs, "off", "errors", "slow", "sampled", "all")
}
