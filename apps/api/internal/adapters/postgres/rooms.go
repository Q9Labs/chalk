package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type RoomRepository struct {
	queries roomQuerier
}

type roomQuerier interface {
	CreateRoom(ctx context.Context, arg sqlc.CreateRoomParams) (sqlc.Room, error)
	GetTenantRoom(ctx context.Context, arg sqlc.GetTenantRoomParams) (sqlc.Room, error)
	ListTenantRooms(ctx context.Context, arg sqlc.ListTenantRoomsParams) ([]sqlc.Room, error)
	UpdateTenantRoom(ctx context.Context, arg sqlc.UpdateTenantRoomParams) (sqlc.Room, error)
	CreateRoomSession(ctx context.Context, arg sqlc.CreateRoomSessionParams) (sqlc.RoomSession, error)
	GetTenantRoomSession(ctx context.Context, arg sqlc.GetTenantRoomSessionParams) (sqlc.RoomSession, error)
	ListTenantRoomSessions(ctx context.Context, arg sqlc.ListTenantRoomSessionsParams) ([]sqlc.RoomSession, error)
	UpdateTenantRoomSession(ctx context.Context, arg sqlc.UpdateTenantRoomSessionParams) (sqlc.RoomSession, error)
}

func NewRoomRepository(queries roomQuerier) RoomRepository {
	return RoomRepository{queries: queries}
}

func (r RoomRepository) CreateRoom(ctx context.Context, input rooms.CreateRoomInput) (rooms.Room, error) {
	room, err := r.queries.CreateRoom(ctx, sqlc.CreateRoomParams{
		ID:              uuid(input.ID),
		Name:            input.Name,
		TenantID:        uuid(input.TenantID),
		Status:          input.Status,
		Slug:            input.Slug,
		MediaPlane:      input.MediaPlane,
		Metadata:        jsonBytes(input.Metadata),
		RecurringPolicy: jsonBytes(input.RecurringPolicy),
		CreatedByUserID: uuid(input.CreatedByUserID),
	})
	if err != nil {
		if uniqueConstraintViolation(err, "rooms_tenant_id_slug_key") {
			return rooms.Room{}, rooms.ErrRoomSlugAlreadyUsed
		}
		return rooms.Room{}, fmt.Errorf("create room: %w", err)
	}

	return mapRoom(room), nil
}

func (r RoomRepository) GetRoom(ctx context.Context, tenantID utilities.ID, roomID utilities.ID) (rooms.Room, error) {
	room, err := r.queries.GetTenantRoom(ctx, sqlc.GetTenantRoomParams{
		TenantID: uuid(tenantID),
		ID:       uuid(roomID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return rooms.Room{}, rooms.ErrRoomNotFound
	}
	if err != nil {
		return rooms.Room{}, fmt.Errorf("get room: %w", err)
	}

	return mapRoom(room), nil
}

func (r RoomRepository) ListRooms(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (rooms.RoomList, error) {
	rows, err := r.queries.ListTenantRooms(ctx, listTenantRoomsParams(tenantID, page))
	if err != nil {
		return rooms.RoomList{}, fmt.Errorf("list rooms: %w", err)
	}

	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}

	list := rooms.RoomList{
		Rooms: make([]rooms.Room, 0, len(rows)),
		Page:  pagination.Page{PageSize: size, HasMore: hasMore},
	}
	for _, row := range rows {
		list.Rooms = append(list.Rooms, mapRoom(row))
	}
	if hasMore && len(list.Rooms) > 0 {
		last := list.Rooms[len(list.Rooms)-1]
		list.Page.NextCursor = &pagination.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}

	return list, nil
}

func (r RoomRepository) UpdateRoom(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, input rooms.UpdateRoomInput) (rooms.Room, error) {
	room, err := r.queries.UpdateTenantRoom(ctx, sqlc.UpdateTenantRoomParams{
		TenantID:           uuid(tenantID),
		ID:                 uuid(roomID),
		NameSet:            input.Name.Set,
		Name:               requiredText(input.Name),
		StatusSet:          input.Status.Set,
		Status:             requiredText(input.Status),
		SlugSet:            input.Slug.Set,
		Slug:               requiredText(input.Slug),
		MediaPlaneSet:      input.MediaPlane.Set,
		MediaPlane:         requiredText(input.MediaPlane),
		MetadataSet:        input.Metadata.Set,
		Metadata:           jsonBytes(input.Metadata.Value),
		RecurringPolicySet: input.RecurringPolicy.Set,
		RecurringPolicy:    jsonBytes(input.RecurringPolicy.Value),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return rooms.Room{}, rooms.ErrRoomNotFound
	}
	if err != nil {
		if uniqueConstraintViolation(err, "rooms_tenant_id_slug_key") {
			return rooms.Room{}, rooms.ErrRoomSlugAlreadyUsed
		}
		return rooms.Room{}, fmt.Errorf("update room: %w", err)
	}

	return mapRoom(room), nil
}

func (r RoomRepository) CreateSession(ctx context.Context, input rooms.CreateSessionInput) (rooms.Session, error) {
	session, err := r.queries.CreateRoomSession(ctx, sqlc.CreateRoomSessionParams{
		ID:              uuid(input.ID),
		Status:          input.Status,
		Metadata:        jsonBytes(input.Metadata),
		RoomID:          uuid(input.RoomID),
		TenantID:        uuid(input.TenantID),
		CreatedByUserID: uuid(input.CreatedByUserID),
		StartedAt:       timestamptz(input.StartedAt),
		EndedAt:         timestamptz(input.EndedAt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return rooms.Session{}, rooms.ErrRoomNotFound
	}
	if err != nil {
		return rooms.Session{}, fmt.Errorf("create room session: %w", err)
	}

	return mapRoomSession(session), nil
}

func (r RoomRepository) GetSession(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID) (rooms.Session, error) {
	session, err := r.queries.GetTenantRoomSession(ctx, sqlc.GetTenantRoomSessionParams{
		TenantID: uuid(tenantID),
		RoomID:   uuid(roomID),
		ID:       uuid(sessionID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return rooms.Session{}, rooms.ErrSessionNotFound
	}
	if err != nil {
		return rooms.Session{}, fmt.Errorf("get room session: %w", err)
	}

	return mapRoomSession(session), nil
}

func (r RoomRepository) ListSessions(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, page pagination.PageRequest) (rooms.SessionList, error) {
	rows, err := r.queries.ListTenantRoomSessions(ctx, listTenantRoomSessionsParams(tenantID, roomID, page))
	if err != nil {
		return rooms.SessionList{}, fmt.Errorf("list room sessions: %w", err)
	}

	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}

	list := rooms.SessionList{
		Sessions: make([]rooms.Session, 0, len(rows)),
		Page:     pagination.Page{PageSize: size, HasMore: hasMore},
	}
	for _, row := range rows {
		list.Sessions = append(list.Sessions, mapRoomSession(row))
	}
	if hasMore && len(list.Sessions) > 0 {
		last := list.Sessions[len(list.Sessions)-1]
		list.Page.NextCursor = &pagination.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}

	return list, nil
}

func (r RoomRepository) UpdateSession(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID, input rooms.UpdateSessionInput) (rooms.Session, error) {
	session, err := r.queries.UpdateTenantRoomSession(ctx, sqlc.UpdateTenantRoomSessionParams{
		TenantID:     uuid(tenantID),
		RoomID:       uuid(roomID),
		ID:           uuid(sessionID),
		StatusSet:    input.Status.Set,
		Status:       requiredText(input.Status),
		MetadataSet:  input.Metadata.Set,
		Metadata:     jsonBytes(input.Metadata.Value),
		StartedAtSet: input.StartedAt.Set,
		StartedAt:    timestamptz(input.StartedAt.Value),
		EndedAtSet:   input.EndedAt.Set,
		EndedAt:      timestamptz(input.EndedAt.Value),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return rooms.Session{}, rooms.ErrSessionNotFound
	}
	if err != nil {
		return rooms.Session{}, fmt.Errorf("update room session: %w", err)
	}

	return mapRoomSession(session), nil
}

func listTenantRoomsParams(tenantID utilities.ID, page pagination.PageRequest) sqlc.ListTenantRoomsParams {
	cursor := page.Cursor()
	params := sqlc.ListTenantRoomsParams{
		TenantID: uuid(tenantID),
		PageSize: int32(page.Size() + 1),
	}
	if cursor == nil {
		return params
	}

	params.CursorSet = true
	params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
	params.CursorID = uuid(cursor.ID)
	return params
}

func listTenantRoomSessionsParams(tenantID utilities.ID, roomID utilities.ID, page pagination.PageRequest) sqlc.ListTenantRoomSessionsParams {
	cursor := page.Cursor()
	params := sqlc.ListTenantRoomSessionsParams{
		TenantID: uuid(tenantID),
		RoomID:   uuid(roomID),
		PageSize: int32(page.Size() + 1),
	}
	if cursor == nil {
		return params
	}

	params.CursorSet = true
	params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
	params.CursorID = uuid(cursor.ID)
	return params
}

func mapRoom(room sqlc.Room) rooms.Room {
	return rooms.Room{
		ID:              utilities.IDFromBytes(room.ID.Bytes),
		Name:            room.Name,
		TenantID:        utilities.IDFromBytes(room.TenantID.Bytes),
		Status:          room.Status,
		Slug:            room.Slug,
		MediaPlane:      room.MediaPlane,
		Metadata:        jsonRaw(room.Metadata),
		RecurringPolicy: jsonRaw(room.RecurringPolicy),
		CreatedByUserID: nullableID(room.CreatedByUserID),
		UpdatedAt:       timestamp(room.UpdatedAt),
		CreatedAt:       timestamp(room.CreatedAt),
	}
}

func mapRoomSession(session sqlc.RoomSession) rooms.Session {
	return rooms.Session{
		ID:              utilities.IDFromBytes(session.ID.Bytes),
		Status:          session.Status,
		Metadata:        jsonRaw(session.Metadata),
		RoomID:          utilities.IDFromBytes(session.RoomID.Bytes),
		TenantID:        utilities.IDFromBytes(session.TenantID.Bytes),
		CreatedByUserID: nullableID(session.CreatedByUserID),
		StartedAt:       nullableTimestamp(session.StartedAt),
		EndedAt:         nullableTimestamp(session.EndedAt),
		UpdatedAt:       timestamp(session.UpdatedAt),
		CreatedAt:       timestamp(session.CreatedAt),
	}
}

var _ rooms.Repository = RoomRepository{}
