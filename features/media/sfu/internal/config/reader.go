package config

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type reader struct {
	lookup Lookup
	errs   []error
}

func (r *reader) fail(key string, err error) {
	r.errs = append(r.errs, fmt.Errorf("%s: %w", key, err))
}

func (r *reader) text(key, fallback string) string {
	if value, ok := r.lookup(key); ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}

func (r *reader) required(key string) string {
	value := r.text(key, "")
	if value == "" {
		r.fail(key, errors.New("is required"))
	}
	return value
}

func (r *reader) list(key string) []string {
	value := r.text(key, "")
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	for index := range parts {
		parts[index] = strings.TrimSpace(parts[index])
	}
	return parts
}

func (r *reader) boolean(key string, fallback bool) bool {
	value := r.text(key, "")
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		r.fail(key, err)
		return fallback
	}
	return parsed
}

func (r *reader) integer(key string, fallback, minimum, maximum int) int {
	value := r.text(key, "")
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < minimum || parsed > maximum {
		r.fail(key, fmt.Errorf("must be an integer from %d to %d", minimum, maximum))
		return fallback
	}
	return parsed
}

func (r *reader) duration(key string, fallback, minimum, maximum time.Duration) time.Duration {
	value := r.text(key, "")
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed < minimum || parsed > maximum {
		r.fail(key, fmt.Errorf("must be a duration from %s to %s", minimum, maximum))
		return fallback
	}
	return parsed
}
