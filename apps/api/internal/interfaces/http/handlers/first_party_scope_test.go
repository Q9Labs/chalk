package handlers

import (
	domainAuth "github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"testing"
)

func TestRoomCreatorUserIDFromClaims(t *testing.T) {
	userID := uuid.New()

	t.Run("returns user id for first party workspace host tokens", func(t *testing.T) {
		claims := &domainAuth.Claims{
			Subject:     userID.String(),
			WorkspaceID: uuid.New(),
			Role:        "host",
		}

		assert.Equal(t, userID, roomCreatorUserIDFromClaims(claims))
	})

	t.Run("rejects api key host tokens without a workspace", func(t *testing.T) {
		claims := &domainAuth.Claims{
			Subject:  userID.String(),
			TenantID: uuid.New(),
			Role:     "host",
		}

		assert.Equal(t, uuid.Nil, roomCreatorUserIDFromClaims(claims))
	})

	t.Run("rejects room scoped participant tokens", func(t *testing.T) {
		claims := &domainAuth.Claims{
			Subject:     userID.String(),
			WorkspaceID: uuid.New(),
			RoomID:      uuid.New(),
			Role:        "participant",
		}

		assert.Equal(t, uuid.Nil, roomCreatorUserIDFromClaims(claims))
	})

	t.Run("rejects claim subjects", func(t *testing.T) {
		claims := &domainAuth.Claims{
			Subject:     "claim:" + uuid.New().String(),
			WorkspaceID: uuid.New(),
			Role:        "host",
		}

		assert.Equal(t, uuid.Nil, roomCreatorUserIDFromClaims(claims))
	})
}
