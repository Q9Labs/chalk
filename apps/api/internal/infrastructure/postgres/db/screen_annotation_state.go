package db

import (
	"context"

	"github.com/google/uuid"
)

const updateRoomScreenAnnotationState = `-- name: UpdateRoomScreenAnnotationState :exec
UPDATE rooms
SET
    screen_annotation_state = $2,
    updated_at = NOW()
WHERE id = $1
`

func (q *Queries) UpdateRoomScreenAnnotationState(ctx context.Context, id uuid.UUID, state []byte) error {
	_, err := q.db.Exec(ctx, updateRoomScreenAnnotationState, id, state)
	return err
}

const getRoomScreenAnnotationState = `-- name: GetRoomScreenAnnotationState :one
SELECT screen_annotation_state FROM rooms WHERE id = $1
`

func (q *Queries) GetRoomScreenAnnotationState(ctx context.Context, id uuid.UUID) ([]byte, error) {
	row := q.db.QueryRow(ctx, getRoomScreenAnnotationState, id)
	var state []byte
	err := row.Scan(&state)
	return state, err
}
