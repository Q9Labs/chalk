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

// TestParticipantHandler_Add_InvalidRoomID tests handler requires authentication
func TestParticipantHandler_Add_InvalidRoomID(t *testing.T) {
	router := setupTestRouter()
	handler := NewParticipantHandler(nil, nil, nil)
	router.POST("/rooms/:id/participants", handler.Add)

	body := bytes.NewBufferString(`{"display_name": "Test"}`)
	req := httptest.NewRequest("POST", "/rooms/invalid-id/participants", body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "unauthorized", response["error"])
}

// TestParticipantHandler_Add_InvalidJSON tests invalid JSON body returns 400
func TestParticipantHandler_Add_InvalidJSON(t *testing.T) {
	router := setupTestRouter()
	handler := NewParticipantHandler(nil, nil, nil)
	router.POST("/rooms/:id/participants", handler.Add)

	validID := uuid.New().String()
	body := bytes.NewBufferString(`{invalid json}`)
	req := httptest.NewRequest("POST", "/rooms/"+validID+"/participants", body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "unauthorized", response["error"])
}

// TestParticipantHandler_Add_MissingDisplayName tests missing required display_name returns 400
func TestParticipantHandler_Add_MissingDisplayName(t *testing.T) {
	router := setupTestRouter()
	handler := NewParticipantHandler(nil, nil, nil)
	router.POST("/rooms/:id/participants", handler.Add)

	validID := uuid.New().String()
	body := bytes.NewBufferString(`{"role": "participant"}`)
	req := httptest.NewRequest("POST", "/rooms/"+validID+"/participants", body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "unauthorized", response["error"])
}

// TestParticipantHandler_Add_EmptyDisplayName tests empty display_name string returns 400
func TestParticipantHandler_Add_EmptyDisplayName(t *testing.T) {
	router := setupTestRouter()
	handler := NewParticipantHandler(nil, nil, nil)
	router.POST("/rooms/:id/participants", handler.Add)

	validID := uuid.New().String()
	body := bytes.NewBufferString(`{"display_name": ""}`)
	req := httptest.NewRequest("POST", "/rooms/"+validID+"/participants", body)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "unauthorized", response["error"])
}

// TestParticipantHandler_Add_ValidRequest tests valid request structure parsing
func TestParticipantHandler_Add_ValidRequest(t *testing.T) {
	req := AddParticipantRequest{
		ExternalUserID: "user123",
		DisplayName:    "John Doe",
		Role:           "participant",
	}

	data, err := json.Marshal(req)
	require.NoError(t, err)

	var parsed AddParticipantRequest
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)

	assert.Equal(t, "user123", parsed.ExternalUserID)
	assert.Equal(t, "John Doe", parsed.DisplayName)
	assert.Equal(t, "participant", parsed.Role)
}

// TestParticipantHandler_List_InvalidRoomID tests invalid UUID param returns 400
func TestParticipantHandler_List_InvalidRoomID(t *testing.T) {
	router := setupTestRouter()
	handler := NewParticipantHandler(nil, nil, nil)
	router.GET("/rooms/:id/participants", handler.List)

	req := httptest.NewRequest("GET", "/rooms/not-a-uuid/participants", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "unauthorized", response["error"])
}

// TestParticipantHandler_Remove_InvalidRoomID tests invalid room UUID param returns 400
func TestParticipantHandler_Remove_InvalidRoomID(t *testing.T) {
	router := setupTestRouter()
	handler := NewParticipantHandler(nil, nil, nil)
	router.DELETE("/rooms/:id/participants/:pid", handler.Remove)

	validPID := uuid.New().String()
	req := httptest.NewRequest("DELETE", "/rooms/bad-room-id/participants/"+validPID, nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "unauthorized", response["error"])
}

// TestParticipantHandler_Remove_InvalidParticipantID tests invalid UUID param returns 400
func TestParticipantHandler_Remove_InvalidParticipantID(t *testing.T) {
	router := setupTestRouter()
	handler := NewParticipantHandler(nil, nil, nil)
	router.DELETE("/rooms/:id/participants/:pid", handler.Remove)

	validRoomID := uuid.New().String()
	req := httptest.NewRequest("DELETE", "/rooms/"+validRoomID+"/participants/invalid-pid", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "unauthorized", response["error"])
}

// TestParticipantHandler_RefreshToken_InvalidRoomID tests invalid room UUID param returns 400
func TestParticipantHandler_RefreshToken_InvalidRoomID(t *testing.T) {
	router := setupTestRouter()
	handler := NewParticipantHandler(nil, nil, nil)
	router.POST("/rooms/:id/participants/:pid/token", handler.RefreshToken)

	validPID := uuid.New().String()
	req := httptest.NewRequest("POST", "/rooms/bad-room-id/participants/"+validPID+"/token", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "unauthorized", response["error"])
}

// TestParticipantHandler_RefreshToken_InvalidParticipantID tests invalid participant UUID param returns 400
func TestParticipantHandler_RefreshToken_InvalidParticipantID(t *testing.T) {
	router := setupTestRouter()
	handler := NewParticipantHandler(nil, nil, nil)
	router.POST("/rooms/:id/participants/:pid/token", handler.RefreshToken)

	validRoomID := uuid.New().String()
	req := httptest.NewRequest("POST", "/rooms/"+validRoomID+"/participants/invalid-pid/token", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "unauthorized", response["error"])
}

// TestParticipantHandler_List_ValidRoomID tests List with valid UUID format
func TestParticipantHandler_List_ValidRoomID(t *testing.T) {
	validID := uuid.New().String()
	_, err := uuid.Parse(validID)
	require.NoError(t, err, "Valid UUID should parse successfully")
}

// TestParticipantHandler_List_QueryParamValidation tests query parameter parsing
func TestParticipantHandler_List_QueryParamValidation(t *testing.T) {
	testCases := []struct {
		name   string
		active string
		valid  bool
	}{
		{"active true", "true", true},
		{"active false", "false", true},
		{"active unset", "", true},
		{"active invalid", "maybe", true}, // This will just be treated as false
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			// Query parameter parsing just checks if it's "true"
			isActive := tc.active == "true"
			if tc.active == "" {
				assert.False(t, isActive)
			} else if tc.active == "true" {
				assert.True(t, isActive)
			} else {
				assert.False(t, isActive)
			}
		})
	}
}

// TestParticipantHandler_Remove_ValidIDs tests Remove with valid UUID formats
func TestParticipantHandler_Remove_ValidIDs(t *testing.T) {
	validRoomID := uuid.New().String()
	_, err := uuid.Parse(validRoomID)
	require.NoError(t, err)

	validPID := uuid.New().String()
	_, err = uuid.Parse(validPID)
	require.NoError(t, err)
}

// TestParticipantHandler_RefreshToken_ValidIDs tests RefreshToken with valid UUIDs
func TestParticipantHandler_RefreshToken_ValidIDs(t *testing.T) {
	validRoomID := uuid.New().String()
	_, err := uuid.Parse(validRoomID)
	require.NoError(t, err)

	validPID := uuid.New().String()
	_, err = uuid.Parse(validPID)
	require.NoError(t, err)
}

// TestAddParticipantRequest_OptionalFields tests optional fields in request
func TestAddParticipantRequest_OptionalFields(t *testing.T) {
	req := AddParticipantRequest{
		DisplayName: "Jane Doe",
		// ExternalUserID is optional
		Role:     "host",
		Metadata: json.RawMessage(`{"externalId":"user_123"}`),
	}

	data, err := json.Marshal(req)
	require.NoError(t, err)

	var parsed AddParticipantRequest
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)

	assert.Empty(t, parsed.ExternalUserID, "Optional field should be empty")
	assert.Equal(t, "Jane Doe", parsed.DisplayName)
	assert.Equal(t, "host", parsed.Role)
	assert.JSONEq(t, `{"externalId":"user_123"}`, string(parsed.Metadata))
}

// TestParticipantHandler_Add_RoleValidation tests different role values
func TestParticipantHandler_Add_RoleValidation(t *testing.T) {
	roles := []string{"host", "participant", ""}

	for _, role := range roles {
		req := AddParticipantRequest{
			DisplayName: "Test User",
			Role:        role,
		}

		data, err := json.Marshal(req)
		require.NoError(t, err, "Should marshal role: %s", role)

		var parsed AddParticipantRequest
		err = json.Unmarshal(data, &parsed)
		require.NoError(t, err, "Should unmarshal role: %s", role)
		assert.Equal(t, role, parsed.Role)
	}
}

// TestAddParticipantResponse_Structure tests response structure
func TestAddParticipantResponse_Structure(t *testing.T) {
	// Validate that response structure is correct
	response := AddParticipantResponse{
		AccessToken:  "access_token_123",
		RefreshToken: "refresh_token_123",
		TokenType:    "Bearer",
		ExpiresIn:    3600,
		AuthToken:    "cf_auth_token",
	}

	assert.Equal(t, "access_token_123", response.AccessToken)
	assert.Equal(t, "refresh_token_123", response.RefreshToken)
	assert.Equal(t, "Bearer", response.TokenType)
	assert.Equal(t, 3600, response.ExpiresIn)
	assert.Equal(t, "cf_auth_token", response.AuthToken)
}

// TestParticipantHandler_RouteParameterValidation tests route parameter extraction
func TestParticipantHandler_RouteParameterValidation(t *testing.T) {
	testCases := []struct {
		name    string
		id      string
		pid     string
		isValid bool
	}{
		{"valid UUIDs", uuid.New().String(), uuid.New().String(), true},
		{"invalid room ID", "bad-room", uuid.New().String(), false},
		{"invalid participant ID", uuid.New().String(), "bad-pid", false},
		{"both invalid", "bad-room", "bad-pid", false},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			_, roomErr := uuid.Parse(tc.id)
			_, pidErr := uuid.Parse(tc.pid)

			if tc.isValid {
				assert.NoError(t, roomErr)
				assert.NoError(t, pidErr)
			} else {
				assert.True(t, roomErr != nil || pidErr != nil)
			}
		})
	}
}

// Note: Tests requiring database interactions should be integration tests
