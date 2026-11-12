package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

func envBoundedInt32(name string, fallback int32, minimum int32, maximum int32) (int32, error) {
	value, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback, nil
	}

	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 32)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", name, err)
	}
	if parsed < int64(minimum) || parsed > int64(maximum) {
		return 0, fmt.Errorf("%s must be between %d and %d", name, minimum, maximum)
	}
	return int32(parsed), nil
}

func envBoundedMilliseconds(name string, fallback int64, minimum int64, maximum int64) (time.Duration, error) {
	value, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(value) == "" {
		return time.Duration(fallback) * time.Millisecond, nil
	}

	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer number of milliseconds: %w", name, err)
	}
	if parsed < minimum || parsed > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d milliseconds", name, minimum, maximum)
	}
	return time.Duration(parsed) * time.Millisecond, nil
}

func envList(name string) []string {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return nil
	}

	parts := strings.Split(value, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			values = append(values, part)
		}
	}

	return values
}

func envOrDefault(name string, fallback string) string {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return fallback
	}

	return value
}

func envInt32(name string, fallback int32) (int32, error) {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return fallback, nil
	}

	parsed, err := strconv.ParseInt(value, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", name, err)
	}

	return int32(parsed), nil
}

func envFloat64(name string, fallback float64) (float64, error) {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return fallback, nil
	}

	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be a number: %w", name, err)
	}

	return parsed, nil
}

func envMilliseconds(name string, fallback int64) (time.Duration, error) {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return time.Duration(fallback) * time.Millisecond, nil
	}

	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer number of milliseconds: %w", name, err)
	}

	return time.Duration(parsed) * time.Millisecond, nil
}

func envEnum(name string, fallback string, allowed ...string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(envOrDefault(name, fallback)))
	for _, option := range allowed {
		if value == option {
			return value, nil
		}
	}

	return "", fmt.Errorf("%s must be one of: %s", name, strings.Join(allowed, ", "))
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

func envBool(name string) bool {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return false
	}

	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func envStrictBool(name string, fallback bool) (bool, error) {
	value, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback, nil
	}

	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("%s must be true or false", name)
	}
}

// envPositiveMilliseconds reads a duration that must be greater than zero.
func envPositiveMilliseconds(name string, fallback int64) (time.Duration, error) {
	value, err := envMilliseconds(name, fallback)
	if err != nil {
		return 0, err
	}
	if value <= 0 {
		return 0, fmt.Errorf("%s must be greater than zero", name)
	}
	return value, nil
}
