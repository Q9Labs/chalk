package websocket

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type testScreenAnnotationStore struct {
	stateByRoom map[uuid.UUID][]byte
}

func (s *testScreenAnnotationStore) Save(_ context.Context, roomID uuid.UUID, state []byte) error {
	if s.stateByRoom == nil {
		s.stateByRoom = make(map[uuid.UUID][]byte)
	}
	if state == nil {
		delete(s.stateByRoom, roomID)
		return nil
	}
	s.stateByRoom[roomID] = append([]byte(nil), state...)
	return nil
}

func (s *testScreenAnnotationStore) Load(_ context.Context, roomID uuid.UUID) ([]byte, error) {
	if s.stateByRoom == nil {
		return nil, nil
	}
	return append([]byte(nil), s.stateByRoom[roomID]...), nil
}

func TestScreenAnnotationState_StartReplacesPriorSession(t *testing.T) {
	hub := newTestHub()
	roomID := uuid.New()
	sharerID := uuid.New()

	started := hub.StartScreenAnnotationSession(roomID, AnnotationSessionStartPayload{
		ShareSessionID:      "share-1",
		SharerParticipantID: sharerID,
		AccessMode:          AnnotationAccessModeAll,
	})
	assert.Equal(t, "share-1", started.ShareSessionID)

	assert.True(t, hub.UpdateScreenAnnotationState(roomID, AnnotationUpdatePayload{
		ShareSessionID:      "share-1",
		SharerParticipantID: sharerID,
		Items:               json.RawMessage(`[{"id":"item-1","version":1,"updated_at_ms":1000,"deleted":false}]`),
		Seq:                 1,
	}))

	hub.StartScreenAnnotationSession(roomID, AnnotationSessionStartPayload{
		ShareSessionID:      "share-2",
		SharerParticipantID: sharerID,
		AccessMode:          AnnotationAccessModeSharerOnly,
	})

	assert.False(t, hub.UpdateScreenAnnotationState(roomID, AnnotationUpdatePayload{
		ShareSessionID:      "share-1",
		SharerParticipantID: sharerID,
		Items:               json.RawMessage(`[{"id":"item-1","version":2,"updated_at_ms":2000,"deleted":false}]`),
		Seq:                 2,
	}))

	snapshot, ok := hub.GetScreenAnnotationSnapshot(roomID)
	require.True(t, ok)
	assert.Equal(t, "share-2", snapshot.ShareSessionID)
	assert.Equal(t, AnnotationAccessModeSharerOnly, snapshot.AccessMode)

	var items []map[string]any
	require.NoError(t, json.Unmarshal(snapshot.Items, &items))
	assert.Len(t, items, 0)
}

func TestScreenAnnotationState_MergeUsesVersionAndUpdatedAt(t *testing.T) {
	hub := newTestHub()
	roomID := uuid.New()
	sharerID := uuid.New()
	hub.StartScreenAnnotationSession(roomID, AnnotationSessionStartPayload{
		ShareSessionID:      "share-1",
		SharerParticipantID: sharerID,
		AccessMode:          AnnotationAccessModeAll,
	})

	assert.True(t, hub.UpdateScreenAnnotationState(roomID, AnnotationUpdatePayload{
		ShareSessionID:      "share-1",
		SharerParticipantID: sharerID,
		Items:               json.RawMessage(`[{"id":"item-1","version":1,"updated_at_ms":1000,"deleted":false}]`),
		Seq:                 1,
	}))
	assert.True(t, hub.UpdateScreenAnnotationState(roomID, AnnotationUpdatePayload{
		ShareSessionID:      "share-1",
		SharerParticipantID: sharerID,
		Items:               json.RawMessage(`[{"id":"item-1","version":2,"updated_at_ms":2000,"deleted":false}]`),
		Seq:                 2,
	}))
	assert.True(t, hub.UpdateScreenAnnotationState(roomID, AnnotationUpdatePayload{
		ShareSessionID:      "share-1",
		SharerParticipantID: sharerID,
		Items:               json.RawMessage(`[{"id":"item-1","version":2,"updated_at_ms":1500,"deleted":false}]`),
		Seq:                 3,
	}))

	snapshot, ok := hub.GetScreenAnnotationSnapshot(roomID)
	require.True(t, ok)

	var items []map[string]any
	require.NoError(t, json.Unmarshal(snapshot.Items, &items))
	require.Len(t, items, 1)
	assert.Equal(t, float64(2), items[0]["version"])
	assert.Equal(t, float64(2000), items[0]["updated_at_ms"])
}

func TestScreenAnnotationState_RestoreFromPersistedSnapshot(t *testing.T) {
	roomID := uuid.New()
	sharerID := uuid.New()
	store := &testScreenAnnotationStore{}

	persisted, err := json.Marshal(persistedScreenAnnotationState{
		ShareSessionID:      "share-restore",
		SharerParticipantID: sharerID,
		AccessMode:          AnnotationAccessModeAll,
		Items:               []json.RawMessage{json.RawMessage(`{"id":"item-1","version":3,"updated_at_ms":3000,"deleted":false}`)},
		UpdatedAtMs:         3000,
		LastSeq:             7,
	})
	require.NoError(t, err)
	require.NoError(t, store.Save(context.Background(), roomID, persisted))

	hub := newTestHub()
	hub.SetScreenAnnotationStateStore(store)

	snapshot, ok := hub.GetScreenAnnotationSnapshot(roomID)
	require.True(t, ok)
	assert.Equal(t, "share-restore", snapshot.ShareSessionID)
	assert.Equal(t, sharerID, snapshot.SharerParticipantID)
	assert.Equal(t, int64(7), snapshot.LastSeq)
}

func TestScreenAnnotationState_EndClearsPersistedState(t *testing.T) {
	roomID := uuid.New()
	sharerID := uuid.New()
	store := &testScreenAnnotationStore{}
	hub := newTestHub()
	hub.SetScreenAnnotationStateStore(store)
	hub.StartScreenAnnotationSession(roomID, AnnotationSessionStartPayload{
		ShareSessionID:      "share-end",
		SharerParticipantID: sharerID,
		AccessMode:          AnnotationAccessModeAll,
	})

	hub.scheduleScreenAnnotationPersist(roomID)
	time.Sleep(screenAnnotationPersistDebounce + 50*time.Millisecond)
	require.NotEmpty(t, store.stateByRoom[roomID])

	require.True(t, hub.EndScreenAnnotationSession(roomID, "share-end"))
	assert.Nil(t, store.stateByRoom[roomID])
}
