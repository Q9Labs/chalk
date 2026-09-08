package recordingpipeline

import (
	"testing"
	"time"
)

func TestPoolHealthDistinguishesIdleControlFromAdmission(t *testing.T) {
	now := time.Date(2026, time.September, 8, 12, 0, 0, 0, time.UTC)
	idle := PoolHealth{Role: PoolRoleCapture, Reason: "no_demand", ObservedAt: now.Add(-time.Second)}
	if !idle.Healthy(now, 2*time.Minute) {
		t.Fatal("fresh no-demand projection must report a healthy idle controller")
	}
	if idle.AdmissionReady(now, 2*time.Minute) {
		t.Fatal("idle pool must not claim admission-ready capacity")
	}

	ready := PoolHealth{Role: PoolRoleCapture, AdmissionOpen: true, ReadyCapacity: 1, Reason: "ready", ObservedAt: now.Add(-time.Second)}
	if !ready.Healthy(now, 2*time.Minute) || !ready.AdmissionReady(now, 2*time.Minute) {
		t.Fatal("fresh ready capacity must be healthy and admission-ready")
	}

	for name, health := range map[string]PoolHealth{
		"controller unavailable": {Role: PoolRoleCapture, Reason: "controller_unavailable", ObservedAt: now.Add(-time.Second)},
		"stale no demand":        {Role: PoolRoleCapture, Reason: "no_demand", ObservedAt: now.Add(-3 * time.Minute)},
		"invalid idle capacity":  {Role: PoolRoleCapture, AdmissionOpen: true, ReadyCapacity: 1, Reason: "no_demand", ObservedAt: now.Add(-time.Second)},
	} {
		t.Run(name, func(t *testing.T) {
			if health.Healthy(now, 2*time.Minute) {
				t.Fatalf("unhealthy pool reported healthy: %+v", health)
			}
		})
	}
}
