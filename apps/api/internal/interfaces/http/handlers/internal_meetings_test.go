package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	domainAuth "github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"
)

type internalMeetingsQueriesStub struct {
	tenant            db.Tenant
	meetings          []db.ListMeetingsByTenantRow
	workspaceMeetings []db.ListMeetingsByWorkspaceRow
	total             int64
}

func (q *internalMeetingsQueriesStub) GetTenant(context.Context, uuid.UUID) (db.Tenant, error) {
	if q.tenant.ID == uuid.Nil {
		return db.Tenant{}, errors.New("tenant not found")
	}
	return q.tenant, nil
}

func (q *internalMeetingsQueriesStub) ListMeetingsByTenant(context.Context, db.ListMeetingsByTenantParams) ([]db.ListMeetingsByTenantRow, error) {
	return q.meetings, nil
}

func (q *internalMeetingsQueriesStub) ListMeetingsByWorkspace(context.Context, db.ListMeetingsByWorkspaceParams) ([]db.ListMeetingsByWorkspaceRow, error) {
	return q.workspaceMeetings, nil
}

func (q *internalMeetingsQueriesStub) CountMeetingsByTenant(context.Context, uuid.UUID) (int64, error) {
	return q.total, nil
}

func (q *internalMeetingsQueriesStub) CountMeetingsByWorkspace(context.Context, pgtype.UUID) (int64, error) {
	return q.total, nil
}

func TestInternalMeetingsList_LocalUnclaimedTenantAllowed(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tenantID := uuid.New()
	meetingID := uuid.New()
	roomID := uuid.New()
	handler := NewInternalMeetingsHandler(&internalMeetingsQueriesStub{
		tenant: db.Tenant{
			ID:         tenantID,
			TenantKind: "internal",
		},
		workspaceMeetings: []db.ListMeetingsByWorkspaceRow{{
			ID:        meetingID,
			RoomID:    roomID,
			Status:    "ready",
			CreatedAt: time.Now(),
		}},
		total: 1,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/internal/meetings?limit=100&offset=0", nil)
	req.Host = "localhost:8080"
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req
	c.Set(middleware.ClaimsKey, &domainAuth.Claims{TenantID: tenantID, WorkspaceID: uuid.New(), Role: "host"})

	handler.List(c)
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Meetings []map[string]any `json:"meetings"`
		Total    int64            `json:"total"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Len(t, body.Meetings, 1)
	require.Equal(t, int64(1), body.Total)
}

func TestInternalMeetingsList_ProdMissingWorkspaceRequiresLogin(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tenantID := uuid.New()
	handler := NewInternalMeetingsHandler(&internalMeetingsQueriesStub{
		tenant: db.Tenant{
			ID:         tenantID,
			TenantKind: "internal",
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/internal/meetings?limit=100&offset=0", nil)
	req.Host = "chalk-api.q9labs.ai"
	req.Header.Set("X-Forwarded-Proto", "https")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req
	c.Set(middleware.ClaimsKey, &domainAuth.Claims{TenantID: tenantID, Role: "host"})

	handler.List(c)
	require.Equal(t, http.StatusUnauthorized, w.Code)

	var body map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "login required", body["error"])
}

func TestInternalMeetingsList_WorkspaceScopedSessionWorksEverywhere(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tenantID := uuid.New()
	ownerID := uuid.New()
	handler := NewInternalMeetingsHandler(&internalMeetingsQueriesStub{
		tenant: db.Tenant{
			ID:         tenantID,
			TenantKind: "internal",
		},
		total: 0,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/internal/meetings?limit=100&offset=0", nil)
	req.Host = "chalk-api.q9labs.ai"
	req.Header.Set("X-Forwarded-Proto", "https")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req
	c.Set(middleware.ClaimsKey, &domainAuth.Claims{TenantID: tenantID, WorkspaceID: ownerID, Role: "host"})

	handler.List(c)
	require.Equal(t, http.StatusOK, w.Code)
}
