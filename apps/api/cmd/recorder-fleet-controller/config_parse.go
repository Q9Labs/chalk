package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/aws/recorderarchive"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

// parseArchiveCDN accepts all three CDN settings or none; a partial set would silently fall back to S3 and its transfer cost.
func parseArchiveCDN(baseURL, keyPairID, privateKeyBase64 string) (*recorderarchive.CDN, error) {
	if baseURL == "" && keyPairID == "" && privateKeyBase64 == "" {
		return nil, nil
	}
	if baseURL == "" || keyPairID == "" || privateKeyBase64 == "" {
		return nil, fmt.Errorf("%w: archive CDN needs URL, key pair ID and private key together", recorderfleet.ErrInvalidConfig)
	}
	return recorderarchive.NewCDN(baseURL, keyPairID, privateKeyBase64)
}

func envOrDefault(getenv func(string) string, key, fallback string) string {
	if value := getenv(key); value != "" {
		return value
	}
	return fallback
}

func parseRequiredInt(name, value string) (int, error) {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%w: %s", recorderfleet.ErrInvalidConfig, name)
	}
	return parsed, nil
}

func parseDuration(name, value string) (time.Duration, error) {
	parsed, err := time.ParseDuration(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%w: %s", recorderfleet.ErrInvalidConfig, name)
	}
	return parsed, nil
}

func parseOptionalIDs(name, value string) ([]int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	parts := strings.Split(value, ",")
	if len(parts) > 8 {
		return nil, fmt.Errorf("%w: %s", recorderfleet.ErrInvalidConfig, name)
	}
	result := make([]int64, 0, len(parts))
	seen := make(map[int64]struct{}, len(parts))
	for _, part := range parts {
		id, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
		if err != nil || id <= 0 {
			return nil, fmt.Errorf("%w: %s", recorderfleet.ErrInvalidConfig, name)
		}
		if _, duplicate := seen[id]; duplicate {
			return nil, fmt.Errorf("%w: %s", recorderfleet.ErrInvalidConfig, name)
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result, nil
}
