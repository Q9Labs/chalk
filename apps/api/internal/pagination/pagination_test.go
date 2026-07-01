package pagination_test

import (
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestCursorRoundTrip(t *testing.T) {
	createdAt := time.Date(2026, 6, 30, 10, 0, 0, 123, time.UTC)
	id := mustID(t, "11111111-1111-1111-1111-111111111111")

	encoded, err := pagination.EncodeCursor(pagination.Cursor{
		CreatedAt: createdAt,
		ID:        id,
	})
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}

	decoded, err := pagination.DecodeCursor(encoded)
	if err != nil {
		t.Fatalf("decode cursor: %v", err)
	}

	if !decoded.CreatedAt.Equal(createdAt) {
		t.Fatalf("created at = %v, want %v", decoded.CreatedAt, createdAt)
	}
	if decoded.ID.String() != id.String() {
		t.Fatalf("id = %q, want %q", decoded.ID.String(), id.String())
	}
}

func TestDecodeCursorRejectsInvalidValue(t *testing.T) {
	_, err := pagination.DecodeCursor("not-a-cursor")
	if !errors.Is(err, pagination.ErrInvalidCursor) {
		t.Fatalf("error = %v, want %v", err, pagination.ErrInvalidCursor)
	}
}

func TestNewPageRequestRejectsInvalidSize(t *testing.T) {
	_, err := pagination.NewPageRequest(0, nil)
	if !errors.Is(err, pagination.ErrInvalidPageSize) {
		t.Fatalf("error = %v, want %v", err, pagination.ErrInvalidPageSize)
	}

	_, err = pagination.NewPageRequest(pagination.MaxPageSize+1, nil)
	if !errors.Is(err, pagination.ErrInvalidPageSize) {
		t.Fatalf("error = %v, want %v", err, pagination.ErrInvalidPageSize)
	}
}

func TestNewPageRequestKeepsNormalizedValues(t *testing.T) {
	cursor := pagination.Cursor{
		CreatedAt: time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC),
		ID:        mustID(t, "11111111-1111-1111-1111-111111111111"),
	}

	page, err := pagination.NewPageRequest(10, &cursor)
	if err != nil {
		t.Fatalf("new page request: %v", err)
	}

	if page.Size() != 10 {
		t.Fatalf("page size = %d, want 10", page.Size())
	}
	if page.Cursor() == nil {
		t.Fatal("cursor was nil")
	}
	if page.Cursor().ID.String() != cursor.ID.String() {
		t.Fatalf("cursor id = %q, want %q", page.Cursor().ID.String(), cursor.ID.String())
	}
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}

	return id
}
