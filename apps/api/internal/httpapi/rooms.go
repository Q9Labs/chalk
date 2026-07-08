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

type createRoomEndpointRequest struct {
	TenantID utilities.ID
	Body     createRoomRequest
}

type listRoomsRequest struct {
	TenantID utilities.ID
	Page     pagination.PageRequest
}

type getRoomRequest struct {
	TenantID utilities.ID
	RoomID   utilities.ID
}

type updateRoomEndpointRequest struct {
	TenantID utilities.ID
	RoomID   utilities.ID
	Body     updateRoomRequest
}

type createRoomSessionEndpointRequest struct {
	TenantID utilities.ID
	RoomID   utilities.ID
	Body     createRoomSessionRequest
}

type listRoomSessionsRequest struct {
	TenantID utilities.ID
	RoomID   utilities.ID
	Page     pagination.PageRequest
}

type getRoomSessionRequest struct {
	TenantID  utilities.ID
	RoomID    utilities.ID
	SessionID utilities.ID
}

type updateRoomSessionEndpointRequest struct {
	TenantID  utilities.ID
	RoomID    utilities.ID
	SessionID utilities.ID
	Body      updateRoomSessionRequest
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
	for _, endpoint := range roomEndpoints(service, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func roomEndpoints(service RoomService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		createRoomEndpoint(service, authorizer),
		listRoomsEndpoint(service, authorizer),
		getRoomEndpoint(service, authorizer),
		updateRoomEndpoint(service, authorizer),
		createRoomSessionEndpoint(service, authorizer),
		listRoomSessionsEndpoint(service, authorizer),
		getRoomSessionEndpoint(service, authorizer),
		updateRoomSessionEndpoint(service, authorizer),
	}
}

func createRoomEndpoint(service RoomService, authorizer TenantAuthorizer) Endpoint[createRoomEndpointRequest, roomResponse] {
	return Post("/v1/tenants/{tenant_id}/rooms", "/tenants/{tenant_id}/rooms", "createRoom", decodeCreateRoomRequest, func(ctx context.Context, request createRoomEndpointRequest) (roomResponse, error) {
		if service == nil {
			return roomResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeRoomsPermission); err != nil {
			return roomResponse{}, err
		}

		room, err := service.CreateRoom(ctx, request.Body.toCreateInput(request.TenantID, createdByUserID(ctx)))
		if err != nil {
			return roomResponse{}, err
		}
		return newRoomResponse(room), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter()).
		RequestBody("CreateRoomRequest", createRoomRequest{}).
		Responds(http.StatusCreated, "Room", roomResponse{}).
		Errors(roomWriteErrors(apiErrorInvalidRequest, apiErrorRoomSlugAlreadyUsed, apiErrorRateLimited)...).
		MapErrors(roomEndpointAPIError)
}

func listRoomsEndpoint(service RoomService, authorizer TenantAuthorizer) Endpoint[listRoomsRequest, roomListResponse] {
	return Get("/v1/tenants/{tenant_id}/rooms", "/tenants/{tenant_id}/rooms", "listRooms", decodeListRoomsRequest, func(ctx context.Context, request listRoomsRequest) (roomListResponse, error) {
		if service == nil {
			return roomListResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readRoomsPermission); err != nil {
			return roomListResponse{}, err
		}

		list, err := service.ListRooms(ctx, request.TenantID, request.Page)
		if err != nil {
			return roomListResponse{}, err
		}
		return newRoomListResponse(list)
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(append([]APIParameterContract{tenantIDParameter()}, paginationParameters()...)...).
		Responds(http.StatusOK, "RoomList", roomListResponse{}).
		Errors(roomReadErrors(apiErrorInvalidPageSize, apiErrorInvalidCursor)...).
		MapErrors(roomEndpointAPIError)
}

func getRoomEndpoint(service RoomService, authorizer TenantAuthorizer) Endpoint[getRoomRequest, roomResponse] {
	return Get("/v1/tenants/{tenant_id}/rooms/{room_id}", "/tenants/{tenant_id}/rooms/{room_id}", "getRoom", decodeGetRoomRequest, func(ctx context.Context, request getRoomRequest) (roomResponse, error) {
		if service == nil {
			return roomResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readRoomsPermission); err != nil {
			return roomResponse{}, err
		}

		room, err := service.GetRoom(ctx, request.TenantID, request.RoomID)
		if err != nil {
			return roomResponse{}, err
		}
		return newRoomResponse(room), nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(tenantIDParameter(), roomIDParameter()).
		Responds(http.StatusOK, "Room", roomResponse{}).
		Errors(roomReadErrors(apiErrorInvalidRoomID, apiErrorRoomNotFound)...).
		MapErrors(roomEndpointAPIError)
}

func updateRoomEndpoint(service RoomService, authorizer TenantAuthorizer) Endpoint[updateRoomEndpointRequest, roomResponse] {
	return Patch("/v1/tenants/{tenant_id}/rooms/{room_id}", "/tenants/{tenant_id}/rooms/{room_id}", "updateRoom", decodeUpdateRoomRequest, func(ctx context.Context, request updateRoomEndpointRequest) (roomResponse, error) {
		if service == nil {
			return roomResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeRoomsPermission); err != nil {
			return roomResponse{}, err
		}

		room, err := service.UpdateRoom(ctx, request.TenantID, request.RoomID, request.Body.toUpdateInput())
		if err != nil {
			return roomResponse{}, err
		}
		return newRoomResponse(room), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter()).
		RequestBody("UpdateRoomRequest", updateRoomRequest{}).
		Responds(http.StatusOK, "Room", roomResponse{}).
		Errors(roomWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRoomID, apiErrorRoomSlugAlreadyUsed, apiErrorRoomNotFound, apiErrorRateLimited)...).
		MapErrors(roomEndpointAPIError)
}

func createRoomSessionEndpoint(service RoomService, authorizer TenantAuthorizer) Endpoint[createRoomSessionEndpointRequest, roomSessionResponse] {
	return Post("/v1/tenants/{tenant_id}/rooms/{room_id}/sessions", "/tenants/{tenant_id}/rooms/{room_id}/sessions", "createRoomSession", decodeCreateRoomSessionRequest, func(ctx context.Context, request createRoomSessionEndpointRequest) (roomSessionResponse, error) {
		if service == nil {
			return roomSessionResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSessionsPermission); err != nil {
			return roomSessionResponse{}, err
		}

		session, err := service.CreateSession(ctx, request.Body.toCreateInput(request.TenantID, request.RoomID, createdByUserID(ctx)))
		if err != nil {
			return roomSessionResponse{}, err
		}
		return newRoomSessionResponse(session), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter()).
		RequestBody("CreateRoomSessionRequest", createRoomSessionRequest{}).
		Responds(http.StatusCreated, "RoomSession", roomSessionResponse{}).
		Errors(roomWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRoomID, apiErrorInvalidSessionStatus, apiErrorInvalidRoomField, apiErrorRoomNotFound, apiErrorRateLimited)...).
		MapErrors(roomEndpointAPIError)
}

func listRoomSessionsEndpoint(service RoomService, authorizer TenantAuthorizer) Endpoint[listRoomSessionsRequest, roomSessionListResponse] {
	return Get("/v1/tenants/{tenant_id}/rooms/{room_id}/sessions", "/tenants/{tenant_id}/rooms/{room_id}/sessions", "listRoomSessions", decodeListRoomSessionsRequest, func(ctx context.Context, request listRoomSessionsRequest) (roomSessionListResponse, error) {
		if service == nil {
			return roomSessionListResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readSessionsPermission); err != nil {
			return roomSessionListResponse{}, err
		}

		list, err := service.ListSessions(ctx, request.TenantID, request.RoomID, request.Page)
		if err != nil {
			return roomSessionListResponse{}, err
		}
		return newRoomSessionListResponse(list)
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(append([]APIParameterContract{tenantIDParameter(), roomIDParameter()}, paginationParameters()...)...).
		Responds(http.StatusOK, "RoomSessionList", roomSessionListResponse{}).
		Errors(roomReadErrors(apiErrorInvalidRoomID, apiErrorInvalidPageSize, apiErrorInvalidCursor)...).
		MapErrors(roomEndpointAPIError)
}

func getRoomSessionEndpoint(service RoomService, authorizer TenantAuthorizer) Endpoint[getRoomSessionRequest, roomSessionResponse] {
	return Get("/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}", "/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}", "getRoomSession", decodeGetRoomSessionRequest, func(ctx context.Context, request getRoomSessionRequest) (roomSessionResponse, error) {
		if service == nil {
			return roomSessionResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readSessionsPermission); err != nil {
			return roomSessionResponse{}, err
		}

		session, err := service.GetSession(ctx, request.TenantID, request.RoomID, request.SessionID)
		if err != nil {
			return roomSessionResponse{}, err
		}
		return newRoomSessionResponse(session), nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(tenantIDParameter(), roomIDParameter(), sessionIDParameter()).
		Responds(http.StatusOK, "RoomSession", roomSessionResponse{}).
		Errors(roomReadErrors(apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorSessionNotFound)...).
		MapErrors(roomEndpointAPIError)
}

func updateRoomSessionEndpoint(service RoomService, authorizer TenantAuthorizer) Endpoint[updateRoomSessionEndpointRequest, roomSessionResponse] {
	return Patch("/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}", "/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}", "updateRoomSession", decodeUpdateRoomSessionRequest, func(ctx context.Context, request updateRoomSessionEndpointRequest) (roomSessionResponse, error) {
		if service == nil {
			return roomSessionResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSessionsPermission); err != nil {
			return roomSessionResponse{}, err
		}

		session, err := service.UpdateSession(ctx, request.TenantID, request.RoomID, request.SessionID, request.Body.toUpdateInput())
		if err != nil {
			return roomSessionResponse{}, err
		}
		return newRoomSessionResponse(session), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter(), sessionIDParameter()).
		RequestBody("UpdateRoomSessionRequest", updateRoomSessionRequest{}).
		Responds(http.StatusOK, "RoomSession", roomSessionResponse{}).
		Errors(roomWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidSessionStatus, apiErrorInvalidRoomField, apiErrorSessionNotFound, apiErrorRateLimited)...).
		MapErrors(roomEndpointAPIError)
}

func decodeCreateRoomRequest(r *http.Request) (createRoomEndpointRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return createRoomEndpointRequest{}, err
	}
	body, err := decodeJSONBody[createRoomRequest](r)
	if err != nil {
		return createRoomEndpointRequest{}, err
	}
	return createRoomEndpointRequest{TenantID: tenantID, Body: body}, nil
}

func decodeListRoomsRequest(r *http.Request) (listRoomsRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listRoomsRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listRoomsRequest{}, paginationAPIError(err)
	}
	return listRoomsRequest{TenantID: tenantID, Page: page}, nil
}

func decodeGetRoomRequest(r *http.Request) (getRoomRequest, error) {
	tenantID, roomID, err := tenantRoomIDsRequest(r)
	if err != nil {
		return getRoomRequest{}, err
	}
	return getRoomRequest{TenantID: tenantID, RoomID: roomID}, nil
}

func decodeUpdateRoomRequest(r *http.Request) (updateRoomEndpointRequest, error) {
	tenantID, roomID, err := tenantRoomIDsRequest(r)
	if err != nil {
		return updateRoomEndpointRequest{}, err
	}
	body, err := decodeJSONBody[updateRoomRequest](r)
	if err != nil {
		return updateRoomEndpointRequest{}, err
	}
	return updateRoomEndpointRequest{TenantID: tenantID, RoomID: roomID, Body: body}, nil
}

func decodeCreateRoomSessionRequest(r *http.Request) (createRoomSessionEndpointRequest, error) {
	tenantID, roomID, err := tenantRoomIDsRequest(r)
	if err != nil {
		return createRoomSessionEndpointRequest{}, err
	}
	body, err := decodeJSONBody[createRoomSessionRequest](r)
	if err != nil {
		return createRoomSessionEndpointRequest{}, err
	}
	return createRoomSessionEndpointRequest{TenantID: tenantID, RoomID: roomID, Body: body}, nil
}

func decodeListRoomSessionsRequest(r *http.Request) (listRoomSessionsRequest, error) {
	tenantID, roomID, err := tenantRoomIDsRequest(r)
	if err != nil {
		return listRoomSessionsRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listRoomSessionsRequest{}, paginationAPIError(err)
	}
	return listRoomSessionsRequest{TenantID: tenantID, RoomID: roomID, Page: page}, nil
}

func decodeGetRoomSessionRequest(r *http.Request) (getRoomSessionRequest, error) {
	tenantID, roomID, sessionID, err := tenantRoomSessionIDsRequest(r)
	if err != nil {
		return getRoomSessionRequest{}, err
	}
	return getRoomSessionRequest{TenantID: tenantID, RoomID: roomID, SessionID: sessionID}, nil
}

func decodeUpdateRoomSessionRequest(r *http.Request) (updateRoomSessionEndpointRequest, error) {
	tenantID, roomID, sessionID, err := tenantRoomSessionIDsRequest(r)
	if err != nil {
		return updateRoomSessionEndpointRequest{}, err
	}
	body, err := decodeJSONBody[updateRoomSessionRequest](r)
	if err != nil {
		return updateRoomSessionEndpointRequest{}, err
	}
	return updateRoomSessionEndpointRequest{TenantID: tenantID, RoomID: roomID, SessionID: sessionID, Body: body}, nil
}

func tenantRoomIDsRequest(r *http.Request) (utilities.ID, utilities.ID, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	roomID, err := roomIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	return tenantID, roomID, nil
}

func tenantRoomSessionIDsRequest(r *http.Request) (utilities.ID, utilities.ID, utilities.ID, error) {
	tenantID, roomID, err := tenantRoomIDsRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, err
	}
	sessionID, err := sessionIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, err
	}
	return tenantID, roomID, sessionID, nil
}

func roomReadErrors(extra ...APIError) []APIError {
	return append([]APIError{
		apiErrorUnauthenticated,
		apiErrorForbidden,
		apiErrorServiceUnavailable,
		apiErrorInvalidTenantID,
		apiErrorInternal,
	}, extra...)
}

func roomWriteErrors(extra ...APIError) []APIError {
	return append([]APIError{
		apiErrorUnauthenticated,
		apiErrorForbidden,
		apiErrorServiceUnavailable,
		apiErrorInvalidTenantID,
		apiErrorInternal,
	}, extra...)
}

func roomEndpointAPIError(err error) (APIError, bool) {
	if apiErr, ok := roomServiceAPIError(err); ok {
		return apiErr, true
	}
	return authorizationAPIError(err), true
}

func roomServiceAPIError(err error) (APIError, bool) {
	switch {
	case err == nil:
		return APIError{}, false
	case errors.Is(err, rooms.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, rooms.ErrInvalidRoomID):
		return apiErrorInvalidRoomID, true
	case errors.Is(err, rooms.ErrInvalidSessionID):
		return apiErrorInvalidSessionID, true
	case errors.Is(err, rooms.ErrInvalidRoomName):
		return apiErrorInvalidRoomName, true
	case errors.Is(err, rooms.ErrInvalidRoomSlug):
		return apiErrorInvalidRoomSlug, true
	case errors.Is(err, rooms.ErrInvalidRoomStatus):
		return apiErrorInvalidRoomStatus, true
	case errors.Is(err, rooms.ErrInvalidMediaPlane):
		return apiErrorInvalidMediaPlane, true
	case errors.Is(err, rooms.ErrInvalidSessionStatus):
		return apiErrorInvalidSessionStatus, true
	case errors.Is(err, rooms.ErrInvalidRoomField):
		return apiErrorInvalidRoomField, true
	case errors.Is(err, rooms.ErrRoomNotFound):
		return apiErrorRoomNotFound, true
	case errors.Is(err, rooms.ErrRoomSlugAlreadyUsed):
		return apiErrorRoomSlugAlreadyUsed, true
	case errors.Is(err, rooms.ErrSessionNotFound):
		return apiErrorSessionNotFound, true
	default:
		return APIError{}, false
	}
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

func createdByUserID(ctx context.Context) utilities.ID {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok || principal.Kind != authentication.PrincipalUser {
		return utilities.ID{}
	}
	return principal.UserID
}
