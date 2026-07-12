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
	if next == nil {
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

func (q operationQuerier) GetSyncTokenSubject(ctx context.Context, arg sqlc.GetSyncTokenSubjectParams) (sqlc.GetSyncTokenSubjectRow, error) {
	startedAt := time.Now()
	subject, err := q.next.GetSyncTokenSubject(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetSyncTokenSubject", startedAt, err)
	return subject, err
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

func (q operationQuerier) GetJourneyTerminalState(ctx context.Context, journeyID pgtype.UUID) (string, error) {
	startedAt := time.Now()
	state, err := q.next.GetJourneyTerminalState(ctx, journeyID)
	LogOperation(ctx, q.logger, "db.query", "GetJourneyTerminalState", startedAt, err)
	return state, err
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

func (q operationQuerier) InsertJourneyEvent(ctx context.Context, arg sqlc.InsertJourneyEventParams) (pgtype.UUID, error) {
	startedAt := time.Now()
	eventID, err := q.next.InsertJourneyEvent(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "InsertJourneyEvent", startedAt, err)
	return eventID, err
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

func (q operationQuerier) ListJourneyEvents(ctx context.Context, journeyID pgtype.UUID) ([]sqlc.ObservabilityJourneyEvent, error) {
	startedAt := time.Now()
	events, err := q.next.ListJourneyEvents(ctx, journeyID)
	LogOperation(ctx, q.logger, "db.query", "ListJourneyEvents", startedAt, err)
	return events, err
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

func (q operationQuerier) AcceptTranscriptionChunkResult(ctx context.Context, arg sqlc.AcceptTranscriptionChunkResultParams) (sqlc.TranscriptionChunkResult, error) {
	startedAt := time.Now()
	value, err := q.next.AcceptTranscriptionChunkResult(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "AcceptTranscriptionChunkResult", startedAt, err)
	return value, err
}
func (q operationQuerier) CancelArtifactJob(ctx context.Context, arg sqlc.CancelArtifactJobParams) (sqlc.ArtifactJob, error) {
	startedAt := time.Now()
	value, err := q.next.CancelArtifactJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CancelArtifactJob", startedAt, err)
	return value, err
}
func (q operationQuerier) ClaimArtifactJob(ctx context.Context, arg sqlc.ClaimArtifactJobParams) (sqlc.ArtifactJob, error) {
	startedAt := time.Now()
	value, err := q.next.ClaimArtifactJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ClaimArtifactJob", startedAt, err)
	return value, err
}
func (q operationQuerier) CompleteArtifactJob(ctx context.Context, arg sqlc.CompleteArtifactJobParams) (sqlc.ArtifactJob, error) {
	startedAt := time.Now()
	value, err := q.next.CompleteArtifactJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CompleteArtifactJob", startedAt, err)
	return value, err
}
func (q operationQuerier) CreateArtifactJob(ctx context.Context, arg sqlc.CreateArtifactJobParams) (sqlc.ArtifactJob, error) {
	startedAt := time.Now()
	value, err := q.next.CreateArtifactJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateArtifactJob", startedAt, err)
	return value, err
}
func (q operationQuerier) CreateTranscriptionFinalizerJobIfReady(ctx context.Context, arg sqlc.CreateTranscriptionFinalizerJobIfReadyParams) (sqlc.ArtifactJob, error) {
	startedAt := time.Now()
	value, err := q.next.CreateTranscriptionFinalizerJobIfReady(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateTranscriptionFinalizerJobIfReady", startedAt, err)
	return value, err
}
func (q operationQuerier) ClaimTranscriptionFinalizerJob(ctx context.Context, arg sqlc.ClaimTranscriptionFinalizerJobParams) (sqlc.ArtifactJob, error) {
	startedAt := time.Now()
	value, err := q.next.ClaimTranscriptionFinalizerJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ClaimTranscriptionFinalizerJob", startedAt, err)
	return value, err
}
func (q operationQuerier) CreateRequestedTranscription(ctx context.Context, arg sqlc.CreateRequestedTranscriptionParams) (sqlc.Transcription, error) {
	startedAt := time.Now()
	value, err := q.next.CreateRequestedTranscription(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateRequestedTranscription", startedAt, err)
	return value, err
}
func (q operationQuerier) CreateTranscriptChunk(ctx context.Context, arg sqlc.CreateTranscriptChunkParams) (sqlc.TranscriptChunk, error) {
	startedAt := time.Now()
	value, err := q.next.CreateTranscriptChunk(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateTranscriptChunk", startedAt, err)
	return value, err
}
func (q operationQuerier) CreateTranscriptionAttempt(ctx context.Context, arg sqlc.CreateTranscriptionAttemptParams) (sqlc.TranscriptionAttempt, error) {
	startedAt := time.Now()
	value, err := q.next.CreateTranscriptionAttempt(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateTranscriptionAttempt", startedAt, err)
	return value, err
}
func (q operationQuerier) DeleteTenantTranscription(ctx context.Context, arg sqlc.DeleteTenantTranscriptionParams) (sqlc.Transcription, error) {
	startedAt := time.Now()
	value, err := q.next.DeleteTenantTranscription(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "DeleteTenantTranscription", startedAt, err)
	return value, err
}
func (q operationQuerier) FinishTranscriptionAttempt(ctx context.Context, arg sqlc.FinishTranscriptionAttemptParams) (sqlc.TranscriptionAttempt, error) {
	startedAt := time.Now()
	value, err := q.next.FinishTranscriptionAttempt(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "FinishTranscriptionAttempt", startedAt, err)
	return value, err
}
func (q operationQuerier) FinalizeTranscription(ctx context.Context, arg sqlc.FinalizeTranscriptionParams) (sqlc.Transcription, error) {
	startedAt := time.Now()
	value, err := q.next.FinalizeTranscription(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "FinalizeTranscription", startedAt, err)
	return value, err
}
func (q operationQuerier) GetArtifactJob(ctx context.Context, id pgtype.UUID) (sqlc.ArtifactJob, error) {
	startedAt := time.Now()
	value, err := q.next.GetArtifactJob(ctx, id)
	LogOperation(ctx, q.logger, "db.query", "GetArtifactJob", startedAt, err)
	return value, err
}
func (q operationQuerier) GetArtifactJobByIdempotency(ctx context.Context, arg sqlc.GetArtifactJobByIdempotencyParams) (sqlc.ArtifactJob, error) {
	startedAt := time.Now()
	value, err := q.next.GetArtifactJobByIdempotency(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetArtifactJobByIdempotency", startedAt, err)
	return value, err
}
func (q operationQuerier) GetTenantTranscriptionByRecording(ctx context.Context, arg sqlc.GetTenantTranscriptionByRecordingParams) (sqlc.Transcription, error) {
	startedAt := time.Now()
	value, err := q.next.GetTenantTranscriptionByRecording(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetTenantTranscriptionByRecording", startedAt, err)
	return value, err
}
func (q operationQuerier) GetTranscriptionChunkJob(ctx context.Context, transcriptID pgtype.UUID) (sqlc.ArtifactJob, error) {
	startedAt := time.Now()
	value, err := q.next.GetTranscriptionChunkJob(ctx, transcriptID)
	LogOperation(ctx, q.logger, "db.query", "GetTranscriptionChunkJob", startedAt, err)
	return value, err
}
func (q operationQuerier) GetTranscriptChunk(ctx context.Context, id pgtype.UUID) (sqlc.TranscriptChunk, error) {
	startedAt := time.Now()
	value, err := q.next.GetTranscriptChunk(ctx, id)
	LogOperation(ctx, q.logger, "db.query", "GetTranscriptChunk", startedAt, err)
	return value, err
}
func (q operationQuerier) GetTranscriptChunkResult(ctx context.Context, arg sqlc.GetTranscriptChunkResultParams) (sqlc.TranscriptionChunkResult, error) {
	startedAt := time.Now()
	value, err := q.next.GetTranscriptChunkResult(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetTranscriptChunkResult", startedAt, err)
	return value, err
}
func (q operationQuerier) HeartbeatArtifactJob(ctx context.Context, arg sqlc.HeartbeatArtifactJobParams) (sqlc.ArtifactJob, error) {
	startedAt := time.Now()
	value, err := q.next.HeartbeatArtifactJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "HeartbeatArtifactJob", startedAt, err)
	return value, err
}
func (q operationQuerier) ListTranscriptChunks(ctx context.Context, arg sqlc.ListTranscriptChunksParams) ([]sqlc.TranscriptChunk, error) {
	startedAt := time.Now()
	value, err := q.next.ListTranscriptChunks(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListTranscriptChunks", startedAt, err)
	return value, err
}
func (q operationQuerier) LockTenantTranscriptionForUpdate(ctx context.Context, arg sqlc.LockTenantTranscriptionForUpdateParams) (sqlc.Transcription, error) {
	startedAt := time.Now()
	value, err := q.next.LockTenantTranscriptionForUpdate(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "LockTenantTranscriptionForUpdate", startedAt, err)
	return value, err
}
func (q operationQuerier) MarkTranscriptionTranscribing(ctx context.Context, arg sqlc.MarkTranscriptionTranscribingParams) (sqlc.Transcription, error) {
	startedAt := time.Now()
	value, err := q.next.MarkTranscriptionTranscribing(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "MarkTranscriptionTranscribing", startedAt, err)
	return value, err
}
func (q operationQuerier) MarkTranscriptionVerifying(ctx context.Context, arg sqlc.MarkTranscriptionVerifyingParams) (sqlc.Transcription, error) {
	startedAt := time.Now()
	value, err := q.next.MarkTranscriptionVerifying(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "MarkTranscriptionVerifying", startedAt, err)
	return value, err
}
func (q operationQuerier) RecoverExpiredArtifactJobs(ctx context.Context, arg sqlc.RecoverExpiredArtifactJobsParams) ([]sqlc.ArtifactJob, error) {
	startedAt := time.Now()
	value, err := q.next.RecoverExpiredArtifactJobs(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "RecoverExpiredArtifactJobs", startedAt, err)
	return value, err
}
func (q operationQuerier) RequeueArtifactJob(ctx context.Context, arg sqlc.RequeueArtifactJobParams) (sqlc.ArtifactJob, error) {
	startedAt := time.Now()
	value, err := q.next.RequeueArtifactJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "RequeueArtifactJob", startedAt, err)
	return value, err
}
func (q operationQuerier) RetryArtifactJob(ctx context.Context, arg sqlc.RetryArtifactJobParams) (sqlc.ArtifactJob, error) {
	startedAt := time.Now()
	value, err := q.next.RetryArtifactJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "RetryArtifactJob", startedAt, err)
	return value, err
}

func (q operationQuerier) GetRecordingTranscriptionSource(ctx context.Context, arg sqlc.GetRecordingTranscriptionSourceParams) (sqlc.RecordingTranscriptionSource, error) {
	startedAt := time.Now()
	value, err := q.next.GetRecordingTranscriptionSource(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetRecordingTranscriptionSource", startedAt, err)
	return value, err
}
func (q operationQuerier) ListRecordingTranscriptionSourceChunks(ctx context.Context, arg sqlc.ListRecordingTranscriptionSourceChunksParams) ([]sqlc.RecordingTranscriptionSourceChunk, error) {
	startedAt := time.Now()
	value, err := q.next.ListRecordingTranscriptionSourceChunks(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListRecordingTranscriptionSourceChunks", startedAt, err)
	return value, err
}
func (q operationQuerier) ReplaceRecordingTranscriptionSourceChunk(ctx context.Context, arg sqlc.ReplaceRecordingTranscriptionSourceChunkParams) (sqlc.RecordingTranscriptionSourceChunk, error) {
	startedAt := time.Now()
	value, err := q.next.ReplaceRecordingTranscriptionSourceChunk(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ReplaceRecordingTranscriptionSourceChunk", startedAt, err)
	return value, err
}
func (q operationQuerier) UpsertRecordingTranscriptionSource(ctx context.Context, arg sqlc.UpsertRecordingTranscriptionSourceParams) (sqlc.RecordingTranscriptionSource, error) {
	startedAt := time.Now()
	value, err := q.next.UpsertRecordingTranscriptionSource(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "UpsertRecordingTranscriptionSource", startedAt, err)
	return value, err
}
func (q operationQuerier) CreateTranscriptionCleanupJob(ctx context.Context, arg sqlc.CreateTranscriptionCleanupJobParams) (sqlc.TranscriptionCleanupJob, error) {
	startedAt := time.Now()
	value, err := q.next.CreateTranscriptionCleanupJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateTranscriptionCleanupJob", startedAt, err)
	return value, err
}
func (q operationQuerier) GetTranscriptionCleanupJob(ctx context.Context, id pgtype.UUID) (sqlc.TranscriptionCleanupJob, error) {
	startedAt := time.Now()
	value, err := q.next.GetTranscriptionCleanupJob(ctx, id)
	LogOperation(ctx, q.logger, "db.query", "GetTranscriptionCleanupJob", startedAt, err)
	return value, err
}
func (q operationQuerier) ClaimTranscriptionCleanupJob(ctx context.Context, arg sqlc.ClaimTranscriptionCleanupJobParams) (sqlc.TranscriptionCleanupJob, error) {
	startedAt := time.Now()
	value, err := q.next.ClaimTranscriptionCleanupJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ClaimTranscriptionCleanupJob", startedAt, err)
	return value, err
}
func (q operationQuerier) CompleteTranscriptionCleanupJob(ctx context.Context, arg sqlc.CompleteTranscriptionCleanupJobParams) (sqlc.TranscriptionCleanupJob, error) {
	startedAt := time.Now()
	value, err := q.next.CompleteTranscriptionCleanupJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CompleteTranscriptionCleanupJob", startedAt, err)
	return value, err
}
func (q operationQuerier) RetryTranscriptionCleanupJob(ctx context.Context, arg sqlc.RetryTranscriptionCleanupJobParams) (sqlc.TranscriptionCleanupJob, error) {
	startedAt := time.Now()
	value, err := q.next.RetryTranscriptionCleanupJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "RetryTranscriptionCleanupJob", startedAt, err)
	return value, err
}
func (q operationQuerier) RecoverExpiredTranscriptionCleanupJobs(ctx context.Context, arg sqlc.RecoverExpiredTranscriptionCleanupJobsParams) ([]sqlc.TranscriptionCleanupJob, error) {
	startedAt := time.Now()
	value, err := q.next.RecoverExpiredTranscriptionCleanupJobs(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "RecoverExpiredTranscriptionCleanupJobs", startedAt, err)
	return value, err
}

var _ sqlc.Querier = operationQuerier{}
