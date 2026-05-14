package ops

import (
	"fmt"
	"strings"
)

const (
	MaxIdempotencyKeyLength = 255
	MaxSignalKeyLength      = 255
)

type DeclarationIdempotencyKey string

func (k DeclarationIdempotencyKey) String() string { return string(k) }

func NormalizeDeclarationIdempotencyKey(raw string) (DeclarationIdempotencyKey, error) {
	normalized := strings.TrimSpace(raw)
	if normalized == "" {
		return "", nil
	}
	if err := validateOpaqueKey(normalized, MaxIdempotencyKeyLength, ErrInvalidIdempotencyKey); err != nil {
		return "", err
	}
	return DeclarationIdempotencyKey(normalized), nil
}

type MonitorResultKey string

func (k MonitorResultKey) String() string { return string(k) }

func ParseMonitorResultKey(raw string) (MonitorResultKey, error) {
	normalized := strings.TrimSpace(raw)
	if err := validateOpaqueKey(normalized, MaxSignalKeyLength, ErrInvalidMonitorResultKey); err != nil {
		return "", err
	}
	return MonitorResultKey(normalized), nil
}

type HeartbeatEventKey string

func (k HeartbeatEventKey) String() string { return string(k) }

func ParseHeartbeatEventKey(raw string) (HeartbeatEventKey, error) {
	normalized := strings.TrimSpace(raw)
	if err := validateOpaqueKey(normalized, MaxSignalKeyLength, ErrInvalidHeartbeatEventKey); err != nil {
		return "", err
	}
	return HeartbeatEventKey(normalized), nil
}

type AutoDedupeKey string

func (k AutoDedupeKey) String() string { return string(k) }

func BuildAutoDedupeKey(primaryComponentKey ComponentKey, primarySignalKey string) (AutoDedupeKey, error) {
	if !primaryComponentKey.IsValid() {
		return "", fmt.Errorf("%w: component=%q", ErrInvalidAutoDedupeKey, primaryComponentKey)
	}
	signal := strings.TrimSpace(primarySignalKey)
	if err := validateOpaqueKey(signal, MaxSignalKeyLength, ErrInvalidAutoDedupeKey); err != nil {
		return "", err
	}
	return AutoDedupeKey(fmt.Sprintf("%s:%s", primaryComponentKey, signal)), nil
}

func validateOpaqueKey(raw string, maxLen int, baseErr error) error {
	if raw == "" {
		return fmt.Errorf("%w: empty", baseErr)
	}
	if len(raw) > maxLen {
		return fmt.Errorf("%w: too long (%d > %d)", baseErr, len(raw), maxLen)
	}
	if strings.ContainsAny(raw, "\n\r\t") {
		return fmt.Errorf("%w: contains control characters", baseErr)
	}
	return nil
}
