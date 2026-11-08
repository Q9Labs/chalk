package recordingpipeline

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type capturePoolRepository struct {
	Repository
	health    PoolHealth
	healthErr error
	held      []HeldCaptureSlot
}

func (r capturePoolRepository) GetPoolHealth(context.Context, PoolRole) (PoolHealth, error) {
	return r.health, r.healthErr
}

func (r capturePoolRepository) ListHeldCaptureSlots(context.Context, int) ([]HeldCaptureSlot, error) {
	return r.held, nil
}

func TestGetCapturePoolSeparatesTenantSlotsFromOthers(t *testing.T) {
	mine, other := newTestID(t), newTestID(t)
	observed := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)
	own := HeldCaptureSlot{JobID: newTestID(t), TenantID: mine, RecordingID: newTestID(t), EpisodeID: newTestID(t), ClaimedAt: observed}
	foreign := HeldCaptureSlot{JobID: newTestID(t), TenantID: other}
	service := NewService(capturePoolRepository{
		health: PoolHealth{Role: PoolRoleCapture, ReadyCapacity: 3, ObservedAt: observed},
		held:   []HeldCaptureSlot{foreign, own},
	})

	pool, err := service.GetCapturePool(context.Background(), mine)
	if err != nil {
		t.Fatal(err)
	}
	if pool.SlotsTotal != 3 || pool.SlotsUsed != 2 || pool.HeldByOtherTenants != 1 || len(pool.Held) != 1 || pool.Held[0] != own {
		t.Fatalf("pool = %+v", pool)
	}
	if pool.ObservedAt == nil || !pool.ObservedAt.Equal(observed) {
		t.Fatalf("observed at = %v", pool.ObservedAt)
	}
}

func TestGetCapturePoolWithoutHealthHasNoSlots(t *testing.T) {
	service := NewService(capturePoolRepository{healthErr: ErrPoolHealthNotFound})

	pool, err := service.GetCapturePool(context.Background(), newTestID(t))
	if err != nil {
		t.Fatal(err)
	}
	if pool.SlotsTotal != 0 || pool.SlotsUsed != 0 || pool.ObservedAt != nil || len(pool.Held) != 0 {
		t.Fatalf("pool = %+v", pool)
	}
}

func newTestID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
