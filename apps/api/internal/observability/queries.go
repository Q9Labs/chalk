package observability

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

type operationQuerier struct {
	next   sqlc.Querier
	logger *slog.Logger
}

func OperationQueries(next sqlc.Querier, logger *slog.Logger) sqlc.Querier {
	if next == nil || logger == nil {
		return next
	}

	return operationQuerier{
		next:   next,
		logger: logger,
	}
}

func (q operationQuerier) CreateAuditLog(ctx context.Context, arg sqlc.CreateAuditLogParams) (sqlc.AuditLog, error) {
	startedAt := time.Now()
	log, err := q.next.CreateAuditLog(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateAuditLog", startedAt, err)
	return log, err
}

func (q operationQuerier) CreateTenant(ctx context.Context, arg sqlc.CreateTenantParams) (sqlc.CreateTenantRow, error) {
	startedAt := time.Now()
	tenant, err := q.next.CreateTenant(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateTenant", startedAt, err)
	return tenant, err
}

func (q operationQuerier) CreateGoogleUser(ctx context.Context, arg sqlc.CreateGoogleUserParams) (sqlc.CreateGoogleUserRow, error) {
	startedAt := time.Now()
	user, err := q.next.CreateGoogleUser(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateGoogleUser", startedAt, err)
	return user, err
}

func (q operationQuerier) CreateIntegrationConnection(ctx context.Context, arg sqlc.CreateIntegrationConnectionParams) (sqlc.IntegrationConnection, error) {
	startedAt := time.Now()
	connection, err := q.next.CreateIntegrationConnection(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateIntegrationConnection", startedAt, err)
	return connection, err
}

func (q operationQuerier) CreateLoginSession(ctx context.Context, arg sqlc.CreateLoginSessionParams) (sqlc.LoginSession, error) {
	startedAt := time.Now()
	session, err := q.next.CreateLoginSession(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateLoginSession", startedAt, err)
	return session, err
}

func (q operationQuerier) CreatePasswordUser(ctx context.Context, arg sqlc.CreatePasswordUserParams) (sqlc.CreatePasswordUserRow, error) {
	startedAt := time.Now()
	user, err := q.next.CreatePasswordUser(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreatePasswordUser", startedAt, err)
	return user, err
}

func (q operationQuerier) CreateUser(ctx context.Context, arg sqlc.CreateUserParams) (sqlc.User, error) {
	startedAt := time.Now()
	user, err := q.next.CreateUser(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateUser", startedAt, err)
	return user, err
}

func (q operationQuerier) CreateMembership(ctx context.Context, arg sqlc.CreateMembershipParams) (sqlc.Membership, error) {
	startedAt := time.Now()
	membership, err := q.next.CreateMembership(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateMembership", startedAt, err)
	return membership, err
}

func (q operationQuerier) CreateRecording(ctx context.Context, arg sqlc.CreateRecordingParams) (sqlc.Recording, error) {
	startedAt := time.Now()
	recording, err := q.next.CreateRecording(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateRecording", startedAt, err)
	return recording, err
}

func (q operationQuerier) CreateRoom(ctx context.Context, arg sqlc.CreateRoomParams) (sqlc.Room, error) {
	startedAt := time.Now()
	room, err := q.next.CreateRoom(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateRoom", startedAt, err)
	return room, err
}

func (q operationQuerier) CreateRoomSession(ctx context.Context, arg sqlc.CreateRoomSessionParams) (sqlc.RoomSession, error) {
	startedAt := time.Now()
	session, err := q.next.CreateRoomSession(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateRoomSession", startedAt, err)
	return session, err
}

func (q operationQuerier) CreateTranscription(ctx context.Context, arg sqlc.CreateTranscriptionParams) (sqlc.Transcription, error) {
	startedAt := time.Now()
	transcription, err := q.next.CreateTranscription(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateTranscription", startedAt, err)
	return transcription, err
}

func (q operationQuerier) GetTenant(ctx context.Context, id pgtype.UUID) (sqlc.GetTenantRow, error) {
	startedAt := time.Now()
	tenant, err := q.next.GetTenant(ctx, id)
	LogOperation(ctx, q.logger, "db.query", "GetTenant", startedAt, err)
	return tenant, err
}

func (q operationQuerier) GetTenantAuditLog(ctx context.Context, arg sqlc.GetTenantAuditLogParams) (sqlc.AuditLog, error) {
	startedAt := time.Now()
	log, err := q.next.GetTenantAuditLog(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetTenantAuditLog", startedAt, err)
	return log, err
}

func (q operationQuerier) GetIntegrationConnection(ctx context.Context, arg sqlc.GetIntegrationConnectionParams) (sqlc.IntegrationConnection, error) {
	startedAt := time.Now()
	connection, err := q.next.GetIntegrationConnection(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetIntegrationConnection", startedAt, err)
	return connection, err
}

func (q operationQuerier) GetIntegrationConnectionByExternalRef(ctx context.Context, arg sqlc.GetIntegrationConnectionByExternalRefParams) (sqlc.IntegrationConnection, error) {
	startedAt := time.Now()
	connection, err := q.next.GetIntegrationConnectionByExternalRef(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetIntegrationConnectionByExternalRef", startedAt, err)
	return connection, err
}

func (q operationQuerier) GetUser(ctx context.Context, id pgtype.UUID) (sqlc.User, error) {
	startedAt := time.Now()
	user, err := q.next.GetUser(ctx, id)
	LogOperation(ctx, q.logger, "db.query", "GetUser", startedAt, err)
	return user, err
}

func (q operationQuerier) GetLoginSessionByTokenHash(ctx context.Context, tokenHash string) (sqlc.GetLoginSessionByTokenHashRow, error) {
	startedAt := time.Now()
	session, err := q.next.GetLoginSessionByTokenHash(ctx, tokenHash)
	LogOperation(ctx, q.logger, "db.query", "GetLoginSessionByTokenHash", startedAt, err)
	return session, err
}

func (q operationQuerier) GetPasswordIdentityByEmail(ctx context.Context, email string) (sqlc.GetPasswordIdentityByEmailRow, error) {
	startedAt := time.Now()
	identity, err := q.next.GetPasswordIdentityByEmail(ctx, email)
	LogOperation(ctx, q.logger, "db.query", "GetPasswordIdentityByEmail", startedAt, err)
	return identity, err
}

func (q operationQuerier) GetTenantMembershipForUser(ctx context.Context, arg sqlc.GetTenantMembershipForUserParams) (sqlc.Membership, error) {
	startedAt := time.Now()
	membership, err := q.next.GetTenantMembershipForUser(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetTenantMembershipForUser", startedAt, err)
	return membership, err
}

func (q operationQuerier) GetTenantRecording(ctx context.Context, arg sqlc.GetTenantRecordingParams) (sqlc.Recording, error) {
	startedAt := time.Now()
	recording, err := q.next.GetTenantRecording(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetTenantRecording", startedAt, err)
	return recording, err
}

func (q operationQuerier) GetTenantRoom(ctx context.Context, arg sqlc.GetTenantRoomParams) (sqlc.Room, error) {
	startedAt := time.Now()
	room, err := q.next.GetTenantRoom(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetTenantRoom", startedAt, err)
	return room, err
}

func (q operationQuerier) GetTenantRoomSession(ctx context.Context, arg sqlc.GetTenantRoomSessionParams) (sqlc.RoomSession, error) {
	startedAt := time.Now()
	session, err := q.next.GetTenantRoomSession(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetTenantRoomSession", startedAt, err)
	return session, err
}

func (q operationQuerier) GetTenantTranscription(ctx context.Context, arg sqlc.GetTenantTranscriptionParams) (sqlc.Transcription, error) {
	startedAt := time.Now()
	transcription, err := q.next.GetTenantTranscription(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetTenantTranscription", startedAt, err)
	return transcription, err
}

func (q operationQuerier) GetUserByAuthIdentity(ctx context.Context, arg sqlc.GetUserByAuthIdentityParams) (sqlc.User, error) {
	startedAt := time.Now()
	user, err := q.next.GetUserByAuthIdentity(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetUserByAuthIdentity", startedAt, err)
	return user, err
}

func (q operationQuerier) GetUserByEmail(ctx context.Context, email string) (sqlc.User, error) {
	startedAt := time.Now()
	user, err := q.next.GetUserByEmail(ctx, email)
	LogOperation(ctx, q.logger, "db.query", "GetUserByEmail", startedAt, err)
	return user, err
}

func (q operationQuerier) ListTenantMemberships(ctx context.Context, arg sqlc.ListTenantMembershipsParams) ([]sqlc.Membership, error) {
	startedAt := time.Now()
	memberships, err := q.next.ListTenantMemberships(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListTenantMemberships", startedAt, err)
	return memberships, err
}

func (q operationQuerier) ListTenantAuditLogs(ctx context.Context, arg sqlc.ListTenantAuditLogsParams) ([]sqlc.AuditLog, error) {
	startedAt := time.Now()
	logs, err := q.next.ListTenantAuditLogs(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListTenantAuditLogs", startedAt, err)
	return logs, err
}

func (q operationQuerier) ListIntegrationConnections(ctx context.Context, arg sqlc.ListIntegrationConnectionsParams) ([]sqlc.IntegrationConnection, error) {
	startedAt := time.Now()
	connections, err := q.next.ListIntegrationConnections(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListIntegrationConnections", startedAt, err)
	return connections, err
}

func (q operationQuerier) ListTenantRecordings(ctx context.Context, arg sqlc.ListTenantRecordingsParams) ([]sqlc.Recording, error) {
	startedAt := time.Now()
	recordings, err := q.next.ListTenantRecordings(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListTenantRecordings", startedAt, err)
	return recordings, err
}

func (q operationQuerier) ListTenantRoomSessions(ctx context.Context, arg sqlc.ListTenantRoomSessionsParams) ([]sqlc.RoomSession, error) {
	startedAt := time.Now()
	sessions, err := q.next.ListTenantRoomSessions(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListTenantRoomSessions", startedAt, err)
	return sessions, err
}

func (q operationQuerier) ListTenantRooms(ctx context.Context, arg sqlc.ListTenantRoomsParams) ([]sqlc.Room, error) {
	startedAt := time.Now()
	rooms, err := q.next.ListTenantRooms(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListTenantRooms", startedAt, err)
	return rooms, err
}

func (q operationQuerier) ListTenantTranscriptions(ctx context.Context, arg sqlc.ListTenantTranscriptionsParams) ([]sqlc.Transcription, error) {
	startedAt := time.Now()
	transcriptions, err := q.next.ListTenantTranscriptions(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListTenantTranscriptions", startedAt, err)
	return transcriptions, err
}

func (q operationQuerier) ListTenants(ctx context.Context, arg sqlc.ListTenantsParams) ([]sqlc.ListTenantsRow, error) {
	startedAt := time.Now()
	tenants, err := q.next.ListTenants(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListTenants", startedAt, err)
	return tenants, err
}

func (q operationQuerier) ListUsers(ctx context.Context, arg sqlc.ListUsersParams) ([]sqlc.User, error) {
	startedAt := time.Now()
	users, err := q.next.ListUsers(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListUsers", startedAt, err)
	return users, err
}

func (q operationQuerier) UpdateTenant(ctx context.Context, id sqlc.UpdateTenantParams) (sqlc.UpdateTenantRow, error) {
	startedAt := time.Now()
	tenant, err := q.next.UpdateTenant(ctx, id)
	LogOperation(ctx, q.logger, "db.query", "UpdateTenant", startedAt, err)
	return tenant, err
}

func (q operationQuerier) RevokeLoginSession(ctx context.Context, arg sqlc.RevokeLoginSessionParams) (sqlc.LoginSession, error) {
	startedAt := time.Now()
	session, err := q.next.RevokeLoginSession(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "RevokeLoginSession", startedAt, err)
	return session, err
}

func (q operationQuerier) MarkIntegrationConnectionUsed(ctx context.Context, arg sqlc.MarkIntegrationConnectionUsedParams) (sqlc.IntegrationConnection, error) {
	startedAt := time.Now()
	connection, err := q.next.MarkIntegrationConnectionUsed(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "MarkIntegrationConnectionUsed", startedAt, err)
	return connection, err
}

func (q operationQuerier) UpdateIntegrationConnection(ctx context.Context, arg sqlc.UpdateIntegrationConnectionParams) (sqlc.IntegrationConnection, error) {
	startedAt := time.Now()
	connection, err := q.next.UpdateIntegrationConnection(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "UpdateIntegrationConnection", startedAt, err)
	return connection, err
}

func (q operationQuerier) UpdateTenantMembership(ctx context.Context, arg sqlc.UpdateTenantMembershipParams) (sqlc.Membership, error) {
	startedAt := time.Now()
	membership, err := q.next.UpdateTenantMembership(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "UpdateTenantMembership", startedAt, err)
	return membership, err
}

func (q operationQuerier) UpdateTenantRecording(ctx context.Context, arg sqlc.UpdateTenantRecordingParams) (sqlc.Recording, error) {
	startedAt := time.Now()
	recording, err := q.next.UpdateTenantRecording(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "UpdateTenantRecording", startedAt, err)
	return recording, err
}

func (q operationQuerier) UpdateTenantRoom(ctx context.Context, arg sqlc.UpdateTenantRoomParams) (sqlc.Room, error) {
	startedAt := time.Now()
	room, err := q.next.UpdateTenantRoom(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "UpdateTenantRoom", startedAt, err)
	return room, err
}

func (q operationQuerier) UpdateTenantRoomSession(ctx context.Context, arg sqlc.UpdateTenantRoomSessionParams) (sqlc.RoomSession, error) {
	startedAt := time.Now()
	session, err := q.next.UpdateTenantRoomSession(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "UpdateTenantRoomSession", startedAt, err)
	return session, err
}

func (q operationQuerier) UpdateTenantTranscription(ctx context.Context, arg sqlc.UpdateTenantTranscriptionParams) (sqlc.Transcription, error) {
	startedAt := time.Now()
	transcription, err := q.next.UpdateTenantTranscription(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "UpdateTenantTranscription", startedAt, err)
	return transcription, err
}

var _ sqlc.Querier = operationQuerier{}
