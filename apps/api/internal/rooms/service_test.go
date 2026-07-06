package rooms_test

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestUpdateSessionRejectsNullStatusWithSessionStatusError(t *testing.T) {
	service := rooms.NewService(roomRepository{})
	id := mustID(t, "11111111-1111-1111-1111-111111111111")

	_, err := service.UpdateSession(context.Background(), id, id, id, rooms.UpdateSessionInput{
		Status: utilities.OptionalString{Set: true},
	})
	if !errors.Is(err, rooms.ErrInvalidSessionStatus) {
		t.Fatalf("error = %v, want invalid session status", err)
	}
}

type roomRepository struct{}

func (roomRepository) CreateRoom(context.Context, rooms.CreateRoomInput) (rooms.Room, error) {
	return rooms.Room{}, errors.New("unexpected create room call")
}

func (roomRepository) GetRoom(context.Context, utilities.ID, utilities.ID) (rooms.Room, error) {
	return rooms.Room{}, errors.New("unexpected get room call")
}

func (roomRepository) ListRooms(context.Context, utilities.ID, pagination.PageRequest) (rooms.RoomList, error) {
	return rooms.RoomList{}, errors.New("unexpected list rooms call")
}

func (roomRepository) UpdateRoom(context.Context, utilities.ID, utilities.ID, rooms.UpdateRoomInput) (rooms.Room, error) {
	return rooms.Room{}, errors.New("unexpected update room call")
}

func (roomRepository) CreateSession(context.Context, rooms.CreateSessionInput) (rooms.Session, error) {
	return rooms.Session{}, errors.New("unexpected create session call")
}

func (roomRepository) GetSession(context.Context, utilities.ID, utilities.ID, utilities.ID) (rooms.Session, error) {
	return rooms.Session{}, errors.New("unexpected get session call")
}

func (roomRepository) ListSessions(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (rooms.SessionList, error) {
	return rooms.SessionList{}, errors.New("unexpected list sessions call")
}

func (roomRepository) UpdateSession(context.Context, utilities.ID, utilities.ID, utilities.ID, rooms.UpdateSessionInput) (rooms.Session, error) {
	return rooms.Session{}, errors.New("unexpected update session call")
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}
