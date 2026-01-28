package db

import (
	"context"

	"github.com/google/uuid"
)

const updateRoomWhiteboardState = `-- name: UpdateRoomWhiteboardState :exec
UPDATE rooms
SET
    whiteboard_state = $2,
    updated_at = NOW()
WHERE id = $1
`

func (q *Queries) UpdateRoomWhiteboardState(ctx context.Context, id uuid.UUID, state []byte) error {
	_, err := q.db.Exec(ctx, updateRoomWhiteboardState, id, state)
	return err
}

const getRoomWhiteboardState = `-- name: GetRoomWhiteboardState :one
SELECT whiteboard_state FROM rooms WHERE id = $1
`

func (q *Queries) GetRoomWhiteboardState(ctx context.Context, id uuid.UUID) ([]byte, error) {
	row := q.db.QueryRow(ctx, getRoomWhiteboardState, id)
	var state []byte
	err := row.Scan(&state)
	return state, err
}
