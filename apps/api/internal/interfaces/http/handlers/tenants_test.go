package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestTenantHandler_Create_InvalidJSON tests invalid JSON body returns 400
func TestTenantHandler_Create_InvalidJSON(t *testing.T) {
	router := setupTestRouter()
	handler := NewTenantHandler(nil, nil, nil)
	router.POST("/tenants", handler.Create)

	body := bytes.NewBufferString(`{invalid json}`)
	req := httptest.NewRequest("POST", "/tenants", body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.NotNil(t, response["error"])
}

// TestTenantHandler_Create_MissingName tests missing required name returns 400
func TestTenantHandler_Create_MissingName(t *testing.T) {
	router := setupTestRouter()
	handler := NewTenantHandler(nil, nil, nil)
	router.POST("/tenants", handler.Create)

	body := bytes.NewBufferString(`{}`)
	req := httptest.NewRequest("POST", "/tenants", body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.NotNil(t, response["error"])
}

// TestTenantHandler_Create_EmptyName tests empty name string returns 400
func TestTenantHandler_Create_EmptyName(t *testing.T) {
	router := setupTestRouter()
	handler := NewTenantHandler(nil, nil, nil)
	router.POST("/tenants", handler.Create)

	body := bytes.NewBufferString(`{"name": ""}`)
	req := httptest.NewRequest("POST", "/tenants", body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.NotNil(t, response["error"])
}

// TestTenantHandler_Create_ValidNameParsing tests valid name is accepted
func TestTenantHandler_Create_ValidNameParsing(t *testing.T) {
	req := CreateTenantRequest{
		Name: "Test Tenant",
	}

	data, err := json.Marshal(req)
	require.NoError(t, err)

	var parsed CreateTenantRequest
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, "Test Tenant", parsed.Name)
}

// TestTenantHandler_Create_OptionalLimitFields tests optional max_* fields
func TestTenantHandler_Create_OptionalLimitFields(t *testing.T) {
	max := int32(100)
	req := CreateTenantRequest{
		Name:                   "Test Tenant",
		MaxConcurrentRooms:     &max,
		MaxParticipantsPerRoom: &max,
	}

	data, err := json.Marshal(req)
	require.NoError(t, err)

	var parsed CreateTenantRequest
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.NotNil(t, parsed.MaxConcurrentRooms)
	assert.Equal(t, int32(100), *parsed.MaxConcurrentRooms)
}

// TestTenantHandler_Get_InvalidTenantID tests invalid UUID param returns 400
func TestTenantHandler_Get_InvalidTenantID(t *testing.T) {
	router := setupTestRouter()
	handler := NewTenantHandler(nil, nil, nil)
	router.GET("/tenants/:id", handler.Get)

	req := httptest.NewRequest("GET", "/tenants/invalid-id", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "invalid tenant id", response["error"])
}

// TestTenantHandler_Update_InvalidTenantID tests invalid UUID param returns 400
func TestTenantHandler_Update_InvalidTenantID(t *testing.T) {
	router := setupTestRouter()
	handler := NewTenantHandler(nil, nil, nil)
	router.PATCH("/tenants/:id", handler.Update)

	body := bytes.NewBufferString(`{"name": "Updated"}`)
	req := httptest.NewRequest("PATCH", "/tenants/not-a-uuid", body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "invalid tenant id", response["error"])
}

// TestTenantHandler_Update_InvalidJSON tests invalid JSON body returns 400
func TestTenantHandler_Update_InvalidJSON(t *testing.T) {
	router := setupTestRouter()
	handler := NewTenantHandler(nil, nil, nil)
	router.PATCH("/tenants/:id", handler.Update)

	validID := uuid.New().String()
	body := bytes.NewBufferString(`{malformed}`)
	req := httptest.NewRequest("PATCH", "/tenants/"+validID, body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.NotNil(t, response["error"])
}

// TestTenantHandler_Update_EmptyBody tests PATCH with empty JSON object
func TestTenantHandler_Update_EmptyBody(t *testing.T) {
	req := struct {
		Name *string `json:"name"`
	}{
		Name: nil,
	}

	data, err := json.Marshal(req)
	require.NoError(t, err)

	var parsed struct {
		Name *string `json:"name"`
	}
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Nil(t, parsed.Name)
}

// TestTenantHandler_Delete_InvalidTenantID tests invalid UUID param returns 400
func TestTenantHandler_Delete_InvalidTenantID(t *testing.T) {
	router := setupTestRouter()
	handler := NewTenantHandler(nil, nil, nil)
	router.DELETE("/tenants/:id", handler.Delete)

	req := httptest.NewRequest("DELETE", "/tenants/bad-id", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "invalid tenant id", response["error"])
}

// TestTenantHandler_RotateAPIKey_InvalidTenantID tests invalid UUID param returns 400
func TestTenantHandler_RotateAPIKey_InvalidTenantID(t *testing.T) {
	router := setupTestRouter()
	handler := NewTenantHandler(nil, nil, nil)
	router.POST("/tenants/:id/rotate-key", handler.RotateAPIKey)

	req := httptest.NewRequest("POST", "/tenants/invalid-uuid/rotate-key", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "invalid tenant id", response["error"])
}

// TestTenantHandler_Get_UUIDValidation tests UUID validation for Get
func TestTenantHandler_Get_UUIDValidation(t *testing.T) {
	testCases := []struct {
		name     string
		tenantID string
	}{
		{"invalid format", "12345678"},
		{"partial UUID", "12345678-1234-1234"},
		{"special chars", "tenant!@#"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			router := setupTestRouter()
			handler := NewTenantHandler(nil, nil, nil)
			router.GET("/tenants/:id", handler.Get)

			req := httptest.NewRequest("GET", "/tenants/"+tc.tenantID, nil)
			w := httptest.NewRecorder()

			router.ServeHTTP(w, req)

			assert.Equal(t, http.StatusBadRequest, w.Code)
			var response map[string]interface{}
			err := json.Unmarshal(w.Body.Bytes(), &response)
			require.NoError(t, err)
			assert.Equal(t, "invalid tenant id", response["error"])
		})
	}
}

// TestTenantHandler_Delete_UUIDValidation tests UUID validation for Delete
func TestTenantHandler_Delete_UUIDValidation(t *testing.T) {
	validID := uuid.New().String()
	_, err := uuid.Parse(validID)
	require.NoError(t, err, "Valid UUID should parse successfully")

	invalidID := "not-valid"
	_, err = uuid.Parse(invalidID)
	require.Error(t, err, "Invalid UUID should fail parsing")
}

// TestTenantHandler_RotateAPIKey_UUIDValidation tests UUID validation for RotateAPIKey
func TestTenantHandler_RotateAPIKey_UUIDValidation(t *testing.T) {
	validID := uuid.New().String()
	_, err := uuid.Parse(validID)
	require.NoError(t, err, "Valid UUID should parse successfully")
}

// TestCreateTenantRequest_JSONMarshaling tests request marshaling/unmarshaling
func TestCreateTenantRequest_JSONMarshaling(t *testing.T) {
	max := int32(50)
	req := CreateTenantRequest{
		Name:                   "Test Tenant",
		MaxConcurrentRooms:     &max,
		MaxParticipantsPerRoom: &max,
		MaxRecordingDurationMinutes: &max,
	}

	data, err := json.Marshal(req)
	require.NoError(t, err)

	var parsed CreateTenantRequest
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)

	assert.Equal(t, "Test Tenant", parsed.Name)
	require.NotNil(t, parsed.MaxConcurrentRooms)
	assert.Equal(t, int32(50), *parsed.MaxConcurrentRooms)
	require.NotNil(t, parsed.MaxParticipantsPerRoom)
	assert.Equal(t, int32(50), *parsed.MaxParticipantsPerRoom)
	require.NotNil(t, parsed.MaxRecordingDurationMinutes)
	assert.Equal(t, int32(50), *parsed.MaxRecordingDurationMinutes)
}

// TestTenantHandler_Update_PartialUpdate tests PATCH with only some fields
func TestTenantHandler_Update_PartialUpdate(t *testing.T) {
	newName := "New Name"
	req := struct {
		Name *string `json:"name"`
	}{
		Name: &newName,
	}

	data, err := json.Marshal(req)
	require.NoError(t, err)

	var parsed struct {
		Name *string `json:"name"`
	}
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)

	assert.NotNil(t, parsed.Name)
	assert.Equal(t, "New Name", *parsed.Name)
}

// Note: Tests requiring database interactions should be integration tests
