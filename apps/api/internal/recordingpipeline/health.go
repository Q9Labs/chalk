package recordingpipeline

import (
	"strings"
	"time"
)

func ValidatePoolHealth(health PoolHealth) error {
	if health.Role != PoolRoleCapture && health.Role != PoolRoleRender {
		return ErrInvalidJobID
	}
	if health.ReadyCapacity < 0 {
		return ErrCapacityExceeded
	}
	if len(strings.TrimSpace(health.Reason)) > 256 {
		return ErrInvalidLease
	}
	return nil
}

func (health PoolHealth) AdmissionReady(now time.Time, maxAge time.Duration) bool {
	if !health.AdmissionOpen || health.ReadyCapacity <= 0 || maxAge <= 0 || health.ObservedAt.IsZero() {
		return false
	}
	return !health.ObservedAt.After(now) && now.Sub(health.ObservedAt) <= maxAge
}
