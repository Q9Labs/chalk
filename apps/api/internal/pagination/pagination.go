package pagination

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	DefaultPageSize = 25
	MaxPageSize     = 100

	cursorVersion = 1
)

var (
	ErrInvalidPageSize = errors.New("invalid page size")
	ErrInvalidCursor   = errors.New("invalid cursor")
)

type Cursor struct {
	CreatedAt time.Time
	ID        utilities.ID
}

type PageRequest struct {
	size   int
	cursor *Cursor
}

type Page struct {
	PageSize   int
	NextCursor *Cursor
	HasMore    bool
}

type cursorPayload struct {
	Version   int    `json:"v"`
	CreatedAt string `json:"created_at"`
	ID        string `json:"id"`
}

func NewPageRequest(size int, cursor *Cursor) (PageRequest, error) {
	if size < 1 || size > MaxPageSize {
		return PageRequest{}, ErrInvalidPageSize
	}

	return PageRequest{
		size:   size,
		cursor: cursor,
	}, nil
}

func (p PageRequest) Size() int {
	return p.size
}

func (p PageRequest) Cursor() *Cursor {
	return p.cursor
}

func EncodeCursor(cursor Cursor) (string, error) {
	if cursor.CreatedAt.IsZero() || cursor.ID.IsZero() {
		return "", ErrInvalidCursor
	}

	payload, err := json.Marshal(cursorPayload{
		Version:   cursorVersion,
		CreatedAt: cursor.CreatedAt.UTC().Format(time.RFC3339Nano),
		ID:        cursor.ID.String(),
	})
	if err != nil {
		return "", err
	}

	return base64.RawURLEncoding.EncodeToString(payload), nil
}

func DecodeCursor(value string) (Cursor, error) {
	if strings.TrimSpace(value) == "" {
		return Cursor{}, ErrInvalidCursor
	}

	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return Cursor{}, ErrInvalidCursor
	}

	var payload cursorPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return Cursor{}, ErrInvalidCursor
	}
	if payload.Version != cursorVersion {
		return Cursor{}, ErrInvalidCursor
	}

	createdAt, err := time.Parse(time.RFC3339Nano, payload.CreatedAt)
	if err != nil || createdAt.IsZero() {
		return Cursor{}, ErrInvalidCursor
	}

	id, err := utilities.ParseID(payload.ID)
	if err != nil {
		return Cursor{}, ErrInvalidCursor
	}

	return Cursor{
		CreatedAt: createdAt.UTC(),
		ID:        id,
	}, nil
}
