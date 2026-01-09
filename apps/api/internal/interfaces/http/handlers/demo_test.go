package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewDemoHandler(t *testing.T) {
	handler := NewDemoHandler(nil, nil, nil)
	assert.NotNil(t, handler)
	assert.False(t, handler.enabled)
}

func TestNewDemoHandler_Enabled(t *testing.T) {
	os.Setenv("CHALK_ENABLE_DEMO", "true")
	defer os.Unsetenv("CHALK_ENABLE_DEMO")

	handler := NewDemoHandler(nil, nil, nil)
	assert.NotNil(t, handler)
	assert.True(t, handler.enabled)
}

func TestNewDemoHandler_DisabledExplicitly(t *testing.T) {
	os.Setenv("CHALK_ENABLE_DEMO", "false")
	defer os.Unsetenv("CHALK_ENABLE_DEMO")

	handler := NewDemoHandler(nil, nil, nil)
	assert.NotNil(t, handler)
	assert.False(t, handler.enabled)
}

func TestDemoHandler_Join_Disabled(t *testing.T) {
	os.Unsetenv("CHALK_ENABLE_DEMO")

	router := setupTestRouter()
	handler := NewDemoHandler(nil, nil, nil)
	router.POST("/demo/join", handler.Join)

	body := bytes.NewBufferString(`{"room_id": "test-room", "display_name": "Test User"}`)
	req := httptest.NewRequest("POST", "/demo/join", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, false, response["success"])
	assert.Equal(t, "demo mode is disabled", response["error"])
}

func TestDemoHandler_Join_InvalidJSON(t *testing.T) {
	os.Setenv("CHALK_ENABLE_DEMO", "true")
	defer os.Unsetenv("CHALK_ENABLE_DEMO")

	router := setupTestRouter()
	handler := NewDemoHandler(nil, nil, nil)
	router.POST("/demo/join", handler.Join)

	body := bytes.NewBufferString(`{invalid}`)
	req := httptest.NewRequest("POST", "/demo/join", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestDemoHandler_Join_MissingRoomID(t *testing.T) {
	os.Setenv("CHALK_ENABLE_DEMO", "true")
	defer os.Unsetenv("CHALK_ENABLE_DEMO")

	router := setupTestRouter()
	handler := NewDemoHandler(nil, nil, nil)
	router.POST("/demo/join", handler.Join)

	body := bytes.NewBufferString(`{"display_name": "Test User"}`)
	req := httptest.NewRequest("POST", "/demo/join", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestDemoHandler_Join_MissingDisplayName(t *testing.T) {
	os.Setenv("CHALK_ENABLE_DEMO", "true")
	defer os.Unsetenv("CHALK_ENABLE_DEMO")

	router := setupTestRouter()
	handler := NewDemoHandler(nil, nil, nil)
	router.POST("/demo/join", handler.Join)

	body := bytes.NewBufferString(`{"room_id": "test-room"}`)
	req := httptest.NewRequest("POST", "/demo/join", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestDemoJoinRequest_Binding(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testCases := []struct {
		name    string
		json    string
		wantErr bool
	}{
		{"valid", `{"room_id": "test-room", "display_name": "User"}`, false},
		{"missing room_id", `{"display_name": "User"}`, true},
		{"missing display_name", `{"room_id": "test-room"}`, true},
		{"empty room_id", `{"room_id": "", "display_name": "User"}`, true},
		{"empty display_name", `{"room_id": "test-room", "display_name": ""}`, true},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Request = httptest.NewRequest("POST", "/", bytes.NewBufferString(tc.json))
			c.Request.Header.Set("Content-Type", "application/json")

			var req DemoJoinRequest
			err := c.ShouldBindJSON(&req)
			if tc.wantErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestDemoJoinResponse_JSONMarshaling(t *testing.T) {
	resp := DemoJoinResponse{
		Success:       true,
		RoomID:        "room-123",
		ParticipantID: "part-456",
		Token:         "jwt-token",
		AuthToken:     "cf-auth-token",
	}
	resp.Room.ID = "room-123"
	resp.Room.Name = "Test Room"

	data, err := json.Marshal(resp)
	require.NoError(t, err)

	var parsed DemoJoinResponse
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, resp.Success, parsed.Success)
	assert.Equal(t, resp.RoomID, parsed.RoomID)
	assert.Equal(t, resp.ParticipantID, parsed.ParticipantID)
	assert.Equal(t, resp.Token, parsed.Token)
	assert.Equal(t, resp.AuthToken, parsed.AuthToken)
	assert.Equal(t, resp.Room.ID, parsed.Room.ID)
	assert.Equal(t, resp.Room.Name, parsed.Room.Name)
}

// Note: TestDemoHandler_Join with nil queries will panic because
// the handler directly calls database methods. In production,
// the handler always receives valid dependencies via dependency injection.
// Integration tests with a test database should be used for full Join testing.
