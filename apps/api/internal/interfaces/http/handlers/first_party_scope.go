package handlers

import (
	domainAuth "github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	sharedFirstPartyTenantName = "Chalk First Party"
	personalWorkspaceKind      = "personal"
	personalWorkspaceName      = "Personal Workspace"
)

func pgUUIDValue(id uuid.UUID) pgtype.UUID {
	if id == uuid.Nil {
		return pgtype.UUID{}
	}
	return pgtype.UUID{Bytes: id, Valid: true}
}

func userIDFromClaims(claims *domainAuth.Claims) uuid.UUID {
	if claims == nil {
		return uuid.Nil
	}
	userID, err := uuid.Parse(claims.Subject)
	if err != nil {
		return uuid.Nil
	}
	return userID
}

func roomCreatorUserIDFromClaims(claims *domainAuth.Claims) uuid.UUID {
	if claims == nil {
		return uuid.Nil
	}
	if claims.WorkspaceID == uuid.Nil || claims.RoomID != uuid.Nil {
		return uuid.Nil
	}
	return userIDFromClaims(claims)
}

func roomAccessibleToClaims(room *db.Room, claims *domainAuth.Claims) bool {
	if room == nil || claims == nil || room.TenantID != claims.TenantID {
		return false
	}
	if claims.RoomID != uuid.Nil {
		return room.ID == claims.RoomID
	}
	if claims.WorkspaceID != uuid.Nil {
		return room.WorkspaceID.Valid && room.WorkspaceID.Bytes == claims.WorkspaceID
	}
	return true
}
