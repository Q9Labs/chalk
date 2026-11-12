package postgres

import (
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func mapPublicInvite(row sqlc.SpacePublicInvite) publicinvites.Invite {
	return publicinvites.Invite{
		TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes), Handle: append([]byte(nil), row.Handle...),
		Generation: uint64(row.Generation), StateEpoch: uint64(row.StateEpoch), Enabled: row.Enabled, PublicRole: row.PublicRole,
		AdmissionMode: publicinvites.AdmissionMode(row.AdmissionMode), CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt),
		RotatedAt: timestamp(row.RotatedAt), DisabledAt: nullableTimestamp(row.DisabledAt), LastActorID: nullableID(row.LastActorID),
	}
}

func mapPublicArrival(row sqlc.SpacePublicArrival) publicinvites.Arrival {
	var fingerprint [32]byte
	copy(fingerprint[:], row.IdempotencyFingerprint)
	var participantGeneration int64
	if row.ParticipantGeneration.Valid {
		participantGeneration = row.ParticipantGeneration.Int64
	}
	return publicinvites.Arrival{
		ArrivalHandle: utilities.IDFromBytes(row.ArrivalHandle.Bytes), TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes),
		InviteHandle: append([]byte(nil), row.InviteHandle...), InviteGeneration: uint64(row.InviteGeneration), InviteStateEpoch: uint64(row.InviteStateEpoch), IdentityMode: publicinvites.IdentityMode(row.IdentityMode), DisplayName: row.DisplayName,
		GuestCredentialHash: append([]byte(nil), row.GuestCredentialHash...), AccountID: nullableID(row.AccountID), CredentialFamily: publicInviteNullableString(row.CredentialFamily), IdempotencyKey: row.IdempotencyKey,
		IdempotencyFingerprint: fingerprint, State: publicinvites.ArrivalState(row.State), EpisodeID: nullableID(row.EpisodeID), ParticipantID: nullableID(row.ParticipantID), ParticipantGeneration: participantGeneration,
		Provider: publicInviteNullableString(row.Provider), ProviderSubject: publicInviteNullableString(row.ProviderSubject),
		ExpiresAt: timestamp(row.ExpiresAt), TerminalReason: publicInviteNullableString(row.TerminalReason), CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt), TerminalAt: nullableTimestamp(row.TerminalAt),
	}
}

func mapPublicAdmissionProjection(row sqlc.ListPendingSpacePublicAdmissionRequestsRow) publicinvites.AdmissionRequest {
	request := mapPublicAdmissionRequest(row.SpacePublicAdmissionRequest)
	request.State = publicinvites.AdmissionRequestState(row.EffectiveState)
	request.DecisionState = publicinvites.AdmissionDecisionNone
	if row.AdmissionStatus != "pending" {
		return request
	}
	if row.DecisionExternalOperationID.Valid {
		request.DecisionState = publicinvites.AdmissionDecisionInFlight
		switch row.DecisionOperation {
		case "admit_participant":
			request.DecisionAction = publicinvites.DecisionApprove
		case "deny_admission":
			request.DecisionAction = publicinvites.DecisionDeny
		}
	} else if row.SpacePublicAdmissionRequest.DecisionRequestKey.Valid {
		request.DecisionState = publicinvites.AdmissionDecisionRetryable
	}
	return request
}

func mapPublicAdmissionRequest(row sqlc.SpacePublicAdmissionRequest) publicinvites.AdmissionRequest {
	return publicinvites.AdmissionRequest{
		RequestHandle: utilities.IDFromBytes(row.RequestHandle.Bytes), ArrivalHandle: utilities.IDFromBytes(row.ArrivalHandle.Bytes), TenantID: utilities.IDFromBytes(row.TenantID.Bytes),
		SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes), DisplayName: row.DisplayName, State: publicinvites.AdmissionRequestState(row.State), RequestedAt: timestamp(row.RequestedAt),
		ExpiresAt: timestamp(row.ExpiresAt), DecidedAt: nullableTimestamp(row.DecidedAt), DecidedBy: nullableID(row.DecidedBy),
	}
}

func stateString(state publicinvites.ArrivalState) string { return string(state) }

func nullableInt8(value int64) pgtype.Int8 {
	if value <= 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: value, Valid: true}
}

func textValue(value string) pgtype.Text {
	if value == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: value, Valid: true}
}

func publicInviteNullableString(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func nullableErrorFamily(value string) pgtype.Text { return textValue(value) }
