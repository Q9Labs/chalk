package websocket

import (
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
)

func TestWhiteboardState_Merge_VersionAndNonce(t *testing.T) {
	hub := newTestHub()
	roomID := uuid.New()

	sceneID := "scene-1"

	// Base element
	elV1 := `{"id":"a","version":1,"versionNonce":100,"updated":1000,"isDeleted":false,"index":"a0"}`
	payload := WhiteboardUpdateV2Payload{
		SchemaVersion: 2,
		SceneID:       sceneID,
		SyncAll:       false,
		Elements:      json.RawMessage("[" + elV1 + "]"),
		Seq:           1,
	}
	_, applied := hub.UpdateWhiteboardState(roomID, payload)
	assert.True(t, applied)

	// Higher version should win
	elV2 := `{"id":"a","version":2,"versionNonce":200,"updated":2000,"isDeleted":false,"index":"a0"}`
	payload.Elements = json.RawMessage("[" + elV2 + "]")
	payload.Seq = 2
	_, applied = hub.UpdateWhiteboardState(roomID, payload)
	assert.True(t, applied)

	snap := hub.GetWhiteboardSnapshot(roomID)
	var els []elementMeta
	assert.NoError(t, json.Unmarshal(snap.Elements, &els))
	assert.Len(t, els, 1)
	assert.Equal(t, int64(2), els[0].Version)

	// Same version: lower versionNonce should win
	elNonceHigh := `{"id":"b","version":5,"versionNonce":500,"updated":5000,"isDeleted":false,"index":"b0"}`
	elNonceLow := `{"id":"b","version":5,"versionNonce":100,"updated":5001,"isDeleted":false,"index":"b0"}`

	payload.Elements = json.RawMessage("[" + elNonceHigh + "]")
	payload.Seq = 3
	_, _ = hub.UpdateWhiteboardState(roomID, payload)

	payload.Elements = json.RawMessage("[" + elNonceLow + "]")
	payload.Seq = 4
	_, _ = hub.UpdateWhiteboardState(roomID, payload)

	snap = hub.GetWhiteboardSnapshot(roomID)
	els = nil
	assert.NoError(t, json.Unmarshal(snap.Elements, &els))

	// Find b
	var b elementMeta
	for _, el := range els {
		if el.ID == "b" {
			b = el
		}
	}
	assert.Equal(t, int64(5), b.Version)
	assert.Equal(t, int64(100), b.VersionNonce)
}

func TestWhiteboardState_TombstonePrune(t *testing.T) {
	hub := newTestHub()
	roomID := uuid.New()

	sceneID := "scene-1"
	oldUpdated := time.Now().Add(-(whiteboardTombstoneRetention + time.Hour)).UnixMilli()
	tombstone := `{"id":"t","version":1,"versionNonce":1,"updated":` + itoa(oldUpdated) + `,"isDeleted":true,"index":"t0"}`

	_, _ = hub.UpdateWhiteboardState(roomID, WhiteboardUpdateV2Payload{
		SchemaVersion: 2,
		SceneID:       sceneID,
		SyncAll:       false,
		Elements:      json.RawMessage("[" + tombstone + "]"),
		Seq:           1,
	})

	snap := hub.GetWhiteboardSnapshot(roomID)
	var els []elementMeta
	assert.NoError(t, json.Unmarshal(snap.Elements, &els))
	assert.Len(t, els, 0)
}

func TestWhiteboardState_ClearEpochPreventsResurrection(t *testing.T) {
	hub := newTestHub()
	roomID := uuid.New()

	sceneID := "scene-1"
	el := `{"id":"a","version":1,"versionNonce":1,"updated":1000,"isDeleted":false,"index":"a0"}`

	_, _ = hub.UpdateWhiteboardState(roomID, WhiteboardUpdateV2Payload{
		SchemaVersion: 2,
		SceneID:       sceneID,
		SyncAll:       false,
		Elements:      json.RawMessage("[" + el + "]"),
		Seq:           1,
	})

	newSceneID := hub.ClearWhiteboardState(roomID)
	assert.NotEqual(t, sceneID, newSceneID)

	// Stale update should be rejected
	_, applied := hub.UpdateWhiteboardState(roomID, WhiteboardUpdateV2Payload{
		SchemaVersion: 2,
		SceneID:       sceneID,
		SyncAll:       false,
		Elements:      json.RawMessage("[" + el + "]"),
		Seq:           2,
	})
	assert.False(t, applied)

	snap := hub.GetWhiteboardSnapshot(roomID)
	var els []elementMeta
	assert.NoError(t, json.Unmarshal(snap.Elements, &els))
	assert.Len(t, els, 0)
}

func itoa(v int64) string {
	return strconv.FormatInt(v, 10)
}
