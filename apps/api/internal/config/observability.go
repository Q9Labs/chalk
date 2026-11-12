package config

import (
	"fmt"
	"net/url"
	"strings"
	"time"
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

func loadObservability(cfg *Config, environment string) error {
	logFormat, err := envEnum(APILogFormat, DefaultLogFormat, "json", "text")
	if err != nil {
		return err
	}
	logLevel, err := envEnum(APILogLevel, DefaultLogLevel, "debug", "info", "warn", "error")
	if err != nil {
		return err
	}
	otlpEndpoint := strings.TrimSpace(envOrDefault(APIOTLPEndpoint, ""))
	otlpInsecure := envBool(APIOTLPInsecure)
	if err := validateOTLPEndpoint(environment, otlpEndpoint, otlpInsecure); err != nil {
		return err
	}
	operationLogs := envBool(APIOperationLogs)
	requestLogs, err := envRequestLogs(operationLogs)
	if err != nil {
		return err
	}
	requestSampleRate, err := envFloat64(APIRequestSampleRate, DefaultRequestSampleRate)
	if err != nil {
		return err
	}
	if requestSampleRate < 0 || requestSampleRate > 1 {
		return fmt.Errorf("%s must be between 0 and 1", APIRequestSampleRate)
	}
	slowRequestThreshold, err := envMilliseconds(APISlowRequestMS, DefaultSlowRequestMS)
	if err != nil {
		return err
	}
	if slowRequestThreshold < 0 {
		return fmt.Errorf("%s must be non-negative", APISlowRequestMS)
	}
	cfg.Observability = ObservabilityConfig{
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
	}
	return nil
}
