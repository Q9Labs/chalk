package jobs

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
)

// mockRoomEnder implements RoomEnder for testing
type mockRoomEnder struct {
	endRoomCalls []uuid.UUID
	endRoomErr   error
}

func (m *mockRoomEnder) EndRoom(ctx context.Context, roomID uuid.UUID) error {
	m.endRoomCalls = append(m.endRoomCalls, roomID)
	return m.endRoomErr
}

func TestNewRoomCleanup(t *testing.T) {
	cleanup := NewRoomCleanup(nil, nil)
	assert.NotNil(t, cleanup)
	assert.Nil(t, cleanup.db)
	assert.Nil(t, cleanup.roomSvc)
}

func TestRoomCleanup_CleanupEmptyRooms_NilDB_Panics(t *testing.T) {
	// This test documents that nil DB causes a panic
	// In production, DB should never be nil
	cleanup := NewRoomCleanup(nil, nil)
	ctx := context.Background()

	assert.Panics(t, func() {
		_ = cleanup.CleanupEmptyRooms(ctx, 30)
	})
}

func TestRoomCleanup_Run_ContextCancellation(t *testing.T) {
	mock := &mockRoomEnder{}
	cleanup := NewRoomCleanup(nil, mock)
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		cleanup.Run(ctx, 100*time.Millisecond, 30)
		close(done)
	}()

	// Cancel immediately
	cancel()

	// Wait for Run to complete
	select {
	case <-done:
		// Success - Run returned after context cancellation
	case <-time.After(1 * time.Second):
		t.Fatal("Run did not return after context cancellation")
	}
}

func TestRoomEnder_Interface(t *testing.T) {
	// Test that mockRoomEnder implements RoomEnder
	var _ RoomEnder = (*mockRoomEnder)(nil)

	mock := &mockRoomEnder{}
	roomID := uuid.New()

	err := mock.EndRoom(context.Background(), roomID)
	assert.NoError(t, err)
	assert.Equal(t, 1, len(mock.endRoomCalls))
	assert.Equal(t, roomID, mock.endRoomCalls[0])
}

func TestRoomEnder_Interface_WithError(t *testing.T) {
	mock := &mockRoomEnder{
		endRoomErr: errors.New("failed to end room"),
	}
	roomID := uuid.New()

	err := mock.EndRoom(context.Background(), roomID)
	assert.Error(t, err)
	assert.Equal(t, "failed to end room", err.Error())
}
