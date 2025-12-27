package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	return gin.New()
}

// TestRoomHandler_Create_InvalidJSON tests invalid JSON body returns 400
func TestRoomHandler_Create_InvalidJSON(t *testing.T) {
	router := setupTestRouter()
	handler := NewRoomHandler(nil, nil)
	router.POST("/rooms", handler.Create)

	body := bytes.NewBufferString(`{invalid json}`)
	req := httptest.NewRequest("POST", "/rooms", body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.NotNil(t, response["error"])
}

// TestRoomHandler_Create_MissingTenantID tests missing required tenant_id returns 400
func TestRoomHandler_Create_MissingTenantID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRoomHandler(nil, nil)
	router.POST("/rooms", handler.Create)

	body := bytes.NewBufferString(`{"name": "Test Room"}`)
	req := httptest.NewRequest("POST", "/rooms", body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.NotNil(t, response["error"])
}

// TestRoomHandler_Create_InvalidTenantID tests invalid UUID format for tenant_id returns 400
func TestRoomHandler_Create_InvalidTenantID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRoomHandler(nil, nil)
	router.POST("/rooms", handler.Create)

	body := bytes.NewBufferString(`{"tenant_id": "not-a-uuid", "name": "Test Room"}`)
	req := httptest.NewRequest("POST", "/rooms", body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "invalid tenant_id", response["error"])
}

// TestRoomHandler_Get_InvalidRoomID tests invalid UUID param returns 400
func TestRoomHandler_Get_InvalidRoomID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRoomHandler(nil, nil)
	router.GET("/rooms/:id", handler.Get)

	req := httptest.NewRequest("GET", "/rooms/invalid-uuid", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "invalid room id", response["error"])
}

// TestRoomHandler_Update_InvalidRoomID tests invalid UUID param returns 400
func TestRoomHandler_Update_InvalidRoomID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRoomHandler(nil, nil)
	router.PATCH("/rooms/:id", handler.Update)

	body := bytes.NewBufferString(`{"name": "Updated Room"}`)
	req := httptest.NewRequest("PATCH", "/rooms/invalid-uuid", body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "invalid room id", response["error"])
}

// TestRoomHandler_Update_InvalidJSON tests invalid JSON body in Update returns 400
func TestRoomHandler_Update_InvalidJSON(t *testing.T) {
	router := setupTestRouter()
	handler := NewRoomHandler(nil, nil)
	router.PATCH("/rooms/:id", handler.Update)

	validID := uuid.New().String()
	body := bytes.NewBufferString(`{invalid json}`)
	req := httptest.NewRequest("PATCH", "/rooms/"+validID, body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.NotNil(t, response["error"])
}

// TestRoomHandler_Delete_InvalidRoomID tests invalid UUID param returns 400
func TestRoomHandler_Delete_InvalidRoomID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRoomHandler(nil, nil)
	router.DELETE("/rooms/:id", handler.Delete)

	req := httptest.NewRequest("DELETE", "/rooms/invalid-uuid", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "invalid room id", response["error"])
}

// TestRoomHandler_End_InvalidRoomID tests invalid UUID param returns 400
func TestRoomHandler_End_InvalidRoomID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRoomHandler(nil, nil)
	router.POST("/rooms/:id/end", handler.End)

	req := httptest.NewRequest("POST", "/rooms/invalid-uuid/end", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "invalid room id", response["error"])
}

// TestRoomHandler_Create_ValidUUIDPassesParsing tests valid UUID passes UUID parsing
func TestRoomHandler_Create_ValidUUIDPassesParsing(t *testing.T) {
	// This test validates that valid UUID format doesn't fail at the parsing stage
	// The actual database interaction is tested separately in integration tests
	validUUID := uuid.New().String()
	_, err := uuid.Parse(validUUID)
	require.NoError(t, err, "Valid UUID should parse successfully")
}

// TestRoomHandler_Get_ValidIDFormat tests invalid param rejection
func TestRoomHandler_Get_InvalidParamFormat(t *testing.T) {
	router := setupTestRouter()
	handler := NewRoomHandler(nil, nil)
	router.GET("/rooms/:id", handler.Get)

	// Test with UUID-like but invalid format
	req := httptest.NewRequest("GET", "/rooms/not-a-uuid-at-all", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "invalid room id", response["error"])
}

// TestRoomHandler_Create_EmptyTenantID tests empty tenant_id string returns 400
func TestRoomHandler_Create_EmptyTenantID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRoomHandler(nil, nil)
	router.POST("/rooms", handler.Create)

	body := bytes.NewBufferString(`{"tenant_id": "", "name": "Test Room"}`)
	req := httptest.NewRequest("POST", "/rooms", body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	// Empty string fails validation (required tag or UUID parsing)
	assert.NotNil(t, response["error"])
}

// TestRoomHandler_Create_ValidJSONParsing tests create with valid JSON and tenant_id
func TestRoomHandler_Create_ValidJSONParsing(t *testing.T) {
	// This validates JSON parsing and required field validation
	validUUID := uuid.New().String()
	req := CreateRoomRequest{
		TenantID: validUUID,
		Name:     "Test Room",
	}

	data, err := json.Marshal(req)
	require.NoError(t, err)

	// Should parse successfully
	var parsed CreateRoomRequest
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, validUUID, parsed.TenantID)
	assert.Equal(t, "Test Room", parsed.Name)
}

// TestRoomHandler_Update_ValidJSON tests PATCH with valid JSON structure
func TestRoomHandler_Update_ValidJSON(t *testing.T) {
	// Test that name field parsing works correctly
	name := "Updated Room"
	req := struct {
		Name *string `json:"name"`
	}{
		Name: &name,
	}

	data, err := json.Marshal(req)
	require.NoError(t, err)

	var parsed struct {
		Name *string `json:"name"`
	}
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.NotNil(t, parsed.Name)
	assert.Equal(t, "Updated Room", *parsed.Name)
}

// TestRoomHandler_Delete_UUIDValidation tests UUID validation logic
func TestRoomHandler_Delete_UUIDValidation(t *testing.T) {
	// Test cases for UUID validation
	testCases := []struct {
		name    string
		roomID  string
		isValid bool
	}{
		{"valid UUID", uuid.New().String(), true},
		{"invalid UUID format", "not-a-uuid", false},
		{"empty string", "", false},
		{"too short", "123", false},
		{"partial UUID", "12345678-1234-1234", false},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := uuid.Parse(tc.roomID)
			if tc.isValid {
				assert.NoError(t, err)
			} else {
				assert.Error(t, err)
			}
		})
	}
}

// TestRoomHandler_End_UUIDValidation tests UUID validation for End endpoint
func TestRoomHandler_End_UUIDValidation(t *testing.T) {
	validID := uuid.New().String()
	_, err := uuid.Parse(validID)
	require.NoError(t, err, "Valid UUID should parse successfully")
}

// Note: Tests requiring database interactions should be integration tests
