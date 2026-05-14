package handlers

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

type roomJoinCacheStub struct {
	values map[string]string
}

func (c *roomJoinCacheStub) Get(_ context.Context, key string) (string, error) {
	return c.values[key], nil
}

func (c *roomJoinCacheStub) Set(_ context.Context, key string, value interface{}, _ time.Duration) error {
	if c.values == nil {
		c.values = map[string]string{}
	}
	c.values[key] = value.(string)
	return nil
}

func TestJoinRoomNameCacheKey_NormalizesRoomName(t *testing.T) {
	tenantID := uuid.New()
	keyA := joinRoomNameCacheKey(tenantID, "  Math-101 ")
	keyB := joinRoomNameCacheKey(tenantID, "math-101")
	require.Equal(t, keyA, keyB)
}

func TestParticipantHandler_RoomNameCacheRoundTrip(t *testing.T) {
	tenantID := uuid.New()
	roomID := uuid.New()

	cacheStub := &roomJoinCacheStub{values: map[string]string{}}
	handler := NewParticipantHandler(nil, nil, cacheStub)

	handler.setCachedRoomID(context.Background(), tenantID, " Algebra ", roomID)
	cachedRoomID, ok := handler.getCachedRoomID(context.Background(), tenantID, "algebra")
	require.True(t, ok)
	require.Equal(t, roomID, cachedRoomID)
}

func TestParticipantHandler_InvalidCachedRoomIDIsIgnored(t *testing.T) {
	tenantID := uuid.New()
	cacheStub := &roomJoinCacheStub{
		values: map[string]string{
			joinRoomNameCacheKey(tenantID, "physics"): "bad-room-id",
		},
	}
	handler := NewParticipantHandler(nil, nil, cacheStub)

	_, ok := handler.getCachedRoomID(context.Background(), tenantID, "physics")
	require.False(t, ok)
}

func TestDeterministicRoomIDForTenantName_NormalizesRoomName(t *testing.T) {
	tenantID := uuid.New()
	roomIDA := deterministicRoomIDForTenantName(tenantID, "  Algebra-101 ")
	roomIDB := deterministicRoomIDForTenantName(tenantID, "algebra-101")
	require.Equal(t, roomIDA, roomIDB)
}

func TestDeterministicRoomIDForTenantName_IsTenantScoped(t *testing.T) {
	roomName := "physics"
	roomIDA := deterministicRoomIDForTenantName(uuid.New(), roomName)
	roomIDB := deterministicRoomIDForTenantName(uuid.New(), roomName)
	require.NotEqual(t, roomIDA, roomIDB)
}
