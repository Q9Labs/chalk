package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	readRoomsPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeRoomsRead,
		MinimumRole: memberships.RoleViewer,
	}
	writeRoomsPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeRoomsWrite,
		MinimumRole: memberships.RoleMember,
	}
	readSessionsPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeSessionsRead,
		MinimumRole: memberships.RoleViewer,
	}
	writeSessionsPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeSessionsWrite,
		MinimumRole: memberships.RoleMember,
	}
)

type RoomService interface {
	CreateRoom(ctx context.Context, input rooms.CreateRoomInput) (rooms.Room, error)
	GetRoom(ctx context.Context, tenantID utilities.ID, roomID utilities.ID) (rooms.Room, error)
	ListRooms(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (rooms.RoomList, error)
	UpdateRoom(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, input rooms.UpdateRoomInput) (rooms.Room, error)
	CreateSession(ctx context.Context, input rooms.CreateSessionInput) (rooms.Session, error)
	GetSession(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID) (rooms.Session, error)
	ListSessions(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, page pagination.PageRequest) (rooms.SessionList, error)
	UpdateSession(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID, input rooms.UpdateSessionInput) (rooms.Session, error)
}

type roomResponse struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	TenantID        string  `json:"tenant_id"`
	Status          string  `json:"status"`
	Slug            string  `json:"slug"`
	MediaPlane      string  `json:"media_plane"`
	Metadata        any     `json:"metadata"`
	RecurringPolicy any     `json:"recurring_policy"`
	CreatedByUserID *string `json:"created_by_user_id"`
	UpdatedAt       string  `json:"updated_at"`
	CreatedAt       string  `json:"created_at"`
}

type roomSessionResponse struct {
	ID              string  `json:"id"`
	Status          string  `json:"status"`
	Metadata        any     `json:"metadata"`
	RoomID          string  `json:"room_id"`
	TenantID        string  `json:"tenant_id"`
	CreatedByUserID *string `json:"created_by_user_id"`
	StartedAt       *string `json:"started_at"`
	EndedAt         *string `json:"ended_at"`
	UpdatedAt       string  `json:"updated_at"`
	CreatedAt       string  `json:"created_at"`
}

type roomListResponse struct {
	Rooms      []roomResponse     `json:"rooms"`
	Pagination paginationResponse `json:"pagination"`
}

type roomSessionListResponse struct {
	Sessions   []roomSessionResponse `json:"sessions"`
	Pagination paginationResponse    `json:"pagination"`
}

type createRoomRequest struct {
	Name            string                 `json:"name"`
	Status          string                 `json:"status"`
	Slug            string                 `json:"slug"`
	MediaPlane      string                 `json:"media_plane"`
	Metadata        utilities.OptionalJSON `json:"metadata"`
	RecurringPolicy utilities.OptionalJSON `json:"recurring_policy"`
}

type updateRoomRequest struct {
	Name            utilities.OptionalString `json:"name"`
	Status          utilities.OptionalString `json:"status"`
	Slug            utilities.OptionalString `json:"slug"`
	MediaPlane      utilities.OptionalString `json:"media_plane"`
	Metadata        utilities.OptionalJSON   `json:"metadata"`
	RecurringPolicy utilities.OptionalJSON   `json:"recurring_policy"`
}

type createRoomSessionRequest struct {
	Status    string                 `json:"status"`
	Metadata  utilities.OptionalJSON `json:"metadata"`
	StartedAt *time.Time             `json:"started_at"`
	EndedAt   *time.Time             `json:"ended_at"`
}

type updateRoomSessionRequest struct {
	Status    utilities.OptionalString `json:"status"`
	Metadata  utilities.OptionalJSON   `json:"metadata"`
	StartedAt optionalTimeRequest      `json:"started_at"`
	EndedAt   optionalTimeRequest      `json:"ended_at"`
}

type optionalTimeRequest struct {
	Set   bool
	Value *time.Time
}

func (t *optionalTimeRequest) UnmarshalJSON(data []byte) error {
	t.Set = true
	if string(data) == "null" {
		t.Value = nil
		return nil
	}

	var value time.Time
	if err := value.UnmarshalJSON(data); err != nil {
		return err
	}
	t.Value = &value
	return nil
}

func mountRoomRoutes(r chi.Router, service RoomService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	r.With(rateLimit(limits, authenticatedWriteRateLimit)).Post("/tenants/{tenant_id}/rooms", handleCreateRoom(service, authorizer))
	r.Get("/tenants/{tenant_id}/rooms", handleListRooms(service, authorizer))
	r.Get("/tenants/{tenant_id}/rooms/{room_id}", handleGetRoom(service, authorizer))
	r.With(rateLimit(limits, authenticatedWriteRateLimit)).Patch("/tenants/{tenant_id}/rooms/{room_id}", handleUpdateRoom(service, authorizer))
	r.With(rateLimit(limits, authenticatedWriteRateLimit)).Post("/tenants/{tenant_id}/rooms/{room_id}/sessions", handleCreateRoomSession(service, authorizer))
	r.Get("/tenants/{tenant_id}/rooms/{room_id}/sessions", handleListRoomSessions(service, authorizer))
	r.Get("/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}", handleGetRoomSession(service, authorizer))
	r.With(rateLimit(limits, authenticatedWriteRateLimit)).Patch("/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}", handleUpdateRoomSession(service, authorizer))
}

func handleCreateRoom(service RoomService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, ok := parseRouteID(w, r, "tenant_id", "invalid_tenant_id", "Invalid tenant id")
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, writeRoomsPermission) {
			return
		}

		var request createRoomRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		room, err := service.CreateRoom(r.Context(), request.toCreateInput(tenantID, createdByUserID(r.Context())))
		if writeRoomServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusCreated, newRoomResponse(room))
	}
}

func handleListRooms(service RoomService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, ok := parseRouteID(w, r, "tenant_id", "invalid_tenant_id", "Invalid tenant id")
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, readRoomsPermission) {
			return
		}

		page, err := parsePageRequest(r)
		if writePaginationError(w, err) {
			return
		}

		list, err := service.ListRooms(r.Context(), tenantID, page)
		if writeRoomServiceError(w, err) {
			return
		}

		response, err := newRoomListResponse(list)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}
		writeJSON(w, http.StatusOK, response)
	}
}

func handleGetRoom(service RoomService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, roomID, ok := tenantRoomIDs(w, r)
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, readRoomsPermission) {
			return
		}

		room, err := service.GetRoom(r.Context(), tenantID, roomID)
		if writeRoomServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, newRoomResponse(room))
	}
}

func handleUpdateRoom(service RoomService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, roomID, ok := tenantRoomIDs(w, r)
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, writeRoomsPermission) {
			return
		}

		var request updateRoomRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		room, err := service.UpdateRoom(r.Context(), tenantID, roomID, request.toUpdateInput())
		if writeRoomServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, newRoomResponse(room))
	}
}

func handleCreateRoomSession(service RoomService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, roomID, ok := tenantRoomIDs(w, r)
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, writeSessionsPermission) {
			return
		}

		var request createRoomSessionRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		session, err := service.CreateSession(r.Context(), request.toCreateInput(tenantID, roomID, createdByUserID(r.Context())))
		if writeRoomServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusCreated, newRoomSessionResponse(session))
	}
}

func handleListRoomSessions(service RoomService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, roomID, ok := tenantRoomIDs(w, r)
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, readSessionsPermission) {
			return
		}

		page, err := parsePageRequest(r)
		if writePaginationError(w, err) {
			return
		}

		list, err := service.ListSessions(r.Context(), tenantID, roomID, page)
		if writeRoomServiceError(w, err) {
			return
		}

		response, err := newRoomSessionListResponse(list)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}
		writeJSON(w, http.StatusOK, response)
	}
}

func handleGetRoomSession(service RoomService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, roomID, sessionID, ok := tenantRoomSessionIDs(w, r)
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, readSessionsPermission) {
			return
		}

		session, err := service.GetSession(r.Context(), tenantID, roomID, sessionID)
		if writeRoomServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, newRoomSessionResponse(session))
	}
}

func handleUpdateRoomSession(service RoomService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, roomID, sessionID, ok := tenantRoomSessionIDs(w, r)
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, writeSessionsPermission) {
			return
		}

		var request updateRoomSessionRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		session, err := service.UpdateSession(r.Context(), tenantID, roomID, sessionID, request.toUpdateInput())
		if writeRoomServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, newRoomSessionResponse(session))
	}
}

func writeRoomServiceError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, rooms.ErrInvalidTenantID):
		writeError(w, http.StatusBadRequest, "invalid_tenant_id", "Invalid tenant id")
	case errors.Is(err, rooms.ErrInvalidRoomID):
		writeError(w, http.StatusBadRequest, "invalid_room_id", "Invalid room id")
	case errors.Is(err, rooms.ErrInvalidSessionID):
		writeError(w, http.StatusBadRequest, "invalid_session_id", "Invalid session id")
	case errors.Is(err, rooms.ErrInvalidRoomName):
		writeError(w, http.StatusBadRequest, "invalid_room_name", "Invalid room name")
	case errors.Is(err, rooms.ErrInvalidRoomSlug):
		writeError(w, http.StatusBadRequest, "invalid_room_slug", "Invalid room slug")
	case errors.Is(err, rooms.ErrInvalidRoomStatus):
		writeError(w, http.StatusBadRequest, "invalid_room_status", "Invalid room status")
	case errors.Is(err, rooms.ErrInvalidMediaPlane):
		writeError(w, http.StatusBadRequest, "invalid_media_plane", "Invalid media plane")
	case errors.Is(err, rooms.ErrInvalidSessionStatus):
		writeError(w, http.StatusBadRequest, "invalid_session_status", "Invalid session status")
	case errors.Is(err, rooms.ErrInvalidRoomField):
		writeError(w, http.StatusBadRequest, "invalid_room_field", "Invalid room field")
	case errors.Is(err, rooms.ErrRoomNotFound):
		writeError(w, http.StatusNotFound, "not_found", "Room not found")
	case errors.Is(err, rooms.ErrRoomSlugAlreadyUsed):
		writeError(w, http.StatusConflict, "room_slug_already_used", "Room slug already used")
	case errors.Is(err, rooms.ErrSessionNotFound):
		writeError(w, http.StatusNotFound, "not_found", "Room session not found")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
	}
	return true
}

func newRoomListResponse(list rooms.RoomList) (roomListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return roomListResponse{}, err
	}

	response := roomListResponse{Rooms: make([]roomResponse, 0, len(list.Rooms)), Pagination: page}
	for _, room := range list.Rooms {
		response.Rooms = append(response.Rooms, newRoomResponse(room))
	}
	return response, nil
}

func newRoomSessionListResponse(list rooms.SessionList) (roomSessionListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return roomSessionListResponse{}, err
	}

	response := roomSessionListResponse{Sessions: make([]roomSessionResponse, 0, len(list.Sessions)), Pagination: page}
	for _, session := range list.Sessions {
		response.Sessions = append(response.Sessions, newRoomSessionResponse(session))
	}
	return response, nil
}

func newRoomResponse(room rooms.Room) roomResponse {
	return roomResponse{
		ID:              room.ID.String(),
		Name:            room.Name,
		TenantID:        room.TenantID.String(),
		Status:          room.Status,
		Slug:            room.Slug,
		MediaPlane:      room.MediaPlane,
		Metadata:        rawJSONValue(room.Metadata),
		RecurringPolicy: rawJSONValue(room.RecurringPolicy),
		CreatedByUserID: optionalIDString(room.CreatedByUserID),
		UpdatedAt:       utilities.FormatTimestamp(room.UpdatedAt),
		CreatedAt:       utilities.FormatTimestamp(room.CreatedAt),
	}
}

func newRoomSessionResponse(session rooms.Session) roomSessionResponse {
	return roomSessionResponse{
		ID:              session.ID.String(),
		Status:          session.Status,
		Metadata:        rawJSONValue(session.Metadata),
		RoomID:          session.RoomID.String(),
		TenantID:        session.TenantID.String(),
		CreatedByUserID: optionalIDString(session.CreatedByUserID),
		StartedAt:       optionalTimestampString(session.StartedAt),
		EndedAt:         optionalTimestampString(session.EndedAt),
		UpdatedAt:       utilities.FormatTimestamp(session.UpdatedAt),
		CreatedAt:       utilities.FormatTimestamp(session.CreatedAt),
	}
}

func (r createRoomRequest) toCreateInput(tenantID utilities.ID, userID utilities.ID) rooms.CreateRoomInput {
	return rooms.CreateRoomInput{
		Name:            r.Name,
		TenantID:        tenantID,
		Status:          r.Status,
		Slug:            r.Slug,
		MediaPlane:      r.MediaPlane,
		Metadata:        r.Metadata.Value,
		RecurringPolicy: r.RecurringPolicy.Value,
		CreatedByUserID: userID,
	}
}

func (r updateRoomRequest) toUpdateInput() rooms.UpdateRoomInput {
	return rooms.UpdateRoomInput{
		Name:            r.Name,
		Status:          r.Status,
		Slug:            r.Slug,
		MediaPlane:      r.MediaPlane,
		Metadata:        r.Metadata,
		RecurringPolicy: r.RecurringPolicy,
	}
}

func (r createRoomSessionRequest) toCreateInput(tenantID utilities.ID, roomID utilities.ID, userID utilities.ID) rooms.CreateSessionInput {
	return rooms.CreateSessionInput{
		Status:          r.Status,
		Metadata:        r.Metadata.Value,
		RoomID:          roomID,
		TenantID:        tenantID,
		CreatedByUserID: userID,
		StartedAt:       r.StartedAt,
		EndedAt:         r.EndedAt,
	}
}

func (r updateRoomSessionRequest) toUpdateInput() rooms.UpdateSessionInput {
	return rooms.UpdateSessionInput{
		Status:   r.Status,
		Metadata: r.Metadata,
		StartedAt: rooms.OptionalTime{
			Set:   r.StartedAt.Set,
			Value: r.StartedAt.Value,
		},
		EndedAt: rooms.OptionalTime{
			Set:   r.EndedAt.Set,
			Value: r.EndedAt.Value,
		},
	}
}

func tenantRoomIDs(w http.ResponseWriter, r *http.Request) (utilities.ID, utilities.ID, bool) {
	tenantID, ok := parseRouteID(w, r, "tenant_id", "invalid_tenant_id", "Invalid tenant id")
	if !ok {
		return utilities.ID{}, utilities.ID{}, false
	}
	roomID, ok := parseRouteID(w, r, "room_id", "invalid_room_id", "Invalid room id")
	if !ok {
		return utilities.ID{}, utilities.ID{}, false
	}
	return tenantID, roomID, true
}

func tenantRoomSessionIDs(w http.ResponseWriter, r *http.Request) (utilities.ID, utilities.ID, utilities.ID, bool) {
	tenantID, roomID, ok := tenantRoomIDs(w, r)
	if !ok {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, false
	}
	sessionID, ok := parseRouteID(w, r, "session_id", "invalid_session_id", "Invalid session id")
	if !ok {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, false
	}
	return tenantID, roomID, sessionID, true
}

func createdByUserID(ctx context.Context) utilities.ID {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok || principal.Kind != authentication.PrincipalUser {
		return utilities.ID{}
	}
	return principal.UserID
}
