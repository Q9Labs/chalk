package websocket

import (
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"nhooyr.io/websocket"
)

func TestClientCloseWith_SetsDisconnectInfo(t *testing.T) {
	c := &Client{
		roomID:        uuid.New(),
		participantID: uuid.New(),
		tenantID:      uuid.New(),
		send:          make(chan []byte, 1),
		done:          make(chan struct{}),
	}

	require.NoError(t, c.CloseWith(websocket.StatusInternalError, "write_error"))

	by, code, reason, err := c.DisconnectInfo()
	require.Equal(t, "server", by)
	require.Equal(t, websocket.StatusInternalError, code)
	require.Equal(t, "write_error", reason)
	require.Empty(t, err)
}

func TestClientSendReliable_Backpressure_UsesPolicyViolation(t *testing.T) {
	c := &Client{
		roomID:        uuid.New(),
		participantID: uuid.New(),
		tenantID:      uuid.New(),
		send:          make(chan []byte, 1),
		done:          make(chan struct{}),
	}

	// Fill buffer to force backpressure close.
	c.send <- []byte("full")
	c.SendReliable([]byte("next"))

	by, code, reason, _ := c.DisconnectInfo()
	require.Equal(t, "server", by)
	require.Equal(t, websocket.StatusPolicyViolation, code)
	require.Equal(t, "backpressure", reason)
}
