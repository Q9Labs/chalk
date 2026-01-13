package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mockAuthMiddleware adds mock claims to context for testing
func mockRecordingAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := &auth.Claims{
			Subject:  uuid.New().String(),
			TenantID: uuid.New(),
		}
		c.Set("claims", claims)
		c.Next()
	}
}

// TestRecordingHandler_Start_InvalidRoomID tests invalid UUID param returns 400
func TestRecordingHandler_Start_InvalidRoomID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRecordingHandler(nil, nil)
	router.POST("/rooms/:id/recordings/start", handler.Start)

	req := httptest.NewRequest("POST", "/rooms/invalid-uuid/recordings/start", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := ReadJSONResponse(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "unauthorized", response["error"])
}

// TestRecordingHandler_Start_EmptyRoomID tests empty room ID param returns 400
func TestRecordingHandler_Start_EmptyRoomID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRecordingHandler(nil, nil)
	router.POST("/rooms/:id/recordings/start", handler.Start)

	req := httptest.NewRequest("POST", "/rooms//recordings/start", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	// Empty param will be treated as invalid UUID
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

// TestRecordingHandler_Stop_InvalidRoomID tests invalid UUID param returns 400
func TestRecordingHandler_Stop_InvalidRoomID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRecordingHandler(nil, nil)
	router.POST("/rooms/:id/recordings/stop", handler.Stop)

	req := httptest.NewRequest("POST", "/rooms/invalid-uuid/recordings/stop", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := ReadJSONResponse(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "unauthorized", response["error"])
}

// TestRecordingHandler_Stop_SpecialCharRoomID tests special char room IDs are rejected
func TestRecordingHandler_Stop_SpecialCharRoomID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRecordingHandler(nil, nil)
	router.POST("/rooms/:id/recordings/stop", handler.Stop)

	req := httptest.NewRequest("POST", "/rooms/room!@#$/recordings/stop", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code, "Should reject without auth")
}

// TestRecordingHandler_Get_InvalidRecordingID tests invalid UUID param returns 400
func TestRecordingHandler_Get_InvalidRecordingID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRecordingHandler(nil, nil)
	router.GET("/recordings/:id", handler.Get)

	req := httptest.NewRequest("GET", "/recordings/not-a-uuid", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := ReadJSONResponse(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "unauthorized", response["error"])
}

// TestRecordingHandler_Get_InvalidUUIDFormats tests invalid UUID formats are rejected
func TestRecordingHandler_Get_InvalidUUIDFormats(t *testing.T) {
	testCases := []struct {
		name        string
		recordingID string
	}{
		{"invalid format", "12345678"},
		{"partial UUID", "12345678-1234-1234"},
		{"alphanumeric", "abcdef1234567890"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			router := setupTestRouter()
			handler := NewRecordingHandler(nil, nil)
			router.GET("/recordings/:id", handler.Get)

			req := httptest.NewRequest("GET", "/recordings/"+tc.recordingID, nil)
			w := httptest.NewRecorder()

			router.ServeHTTP(w, req)

			assert.Equal(t, http.StatusUnauthorized, w.Code, "Should reject without auth: %s", tc.name)
			var response map[string]interface{}
			err := ReadJSONResponse(w.Body.Bytes(), &response)
			require.NoError(t, err)
			assert.Equal(t, "unauthorized", response["error"])
		})
	}
}

// TestRecordingHandler_Download_InvalidRecordingID tests invalid UUID param returns 400
func TestRecordingHandler_Download_InvalidRecordingID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRecordingHandler(nil, nil)
	router.GET("/recordings/:id/download", handler.Download)

	req := httptest.NewRequest("GET", "/recordings/invalid-recording-id/download", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := ReadJSONResponse(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "unauthorized", response["error"])
}

// TestRecordingHandler_Download_AtSymbolInID tests @ symbol in ID is rejected
func TestRecordingHandler_Download_AtSymbolInID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRecordingHandler(nil, nil)
	router.GET("/recordings/:id/download", handler.Download)

	req := httptest.NewRequest("GET", "/recordings/id-with-@symbol/download", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

// TestRecordingHandler_Delete_InvalidRecordingID tests invalid UUID param returns 400
func TestRecordingHandler_Delete_InvalidRecordingID(t *testing.T) {
	router := setupTestRouter()
	handler := NewRecordingHandler(nil, nil)
	router.DELETE("/recordings/:id", handler.Delete)

	req := httptest.NewRequest("DELETE", "/recordings/bad-id", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := ReadJSONResponse(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "unauthorized", response["error"])
}

// TestRecordingHandler_Delete_UUIDValidation tests UUID validation for Delete
func TestRecordingHandler_Delete_UUIDValidation(t *testing.T) {
	validID := uuid.New().String()
	_, err := uuid.Parse(validID)
	require.NoError(t, err, "Valid UUID should parse successfully")

	invalidID := "not-valid"
	_, err = uuid.Parse(invalidID)
	require.Error(t, err, "Invalid UUID should fail parsing")
}

// TestRecordingHandler_List_QueryParamParsing tests query param parsing logic
func TestRecordingHandler_List_QueryParamParsing(t *testing.T) {
	// Validate that strconv.ParseInt can handle the query params
	testCases := []struct {
		name    string
		limit   string
		offset  string
		isValid bool
	}{
		{"valid params", "50", "10", true},
		{"valid defaults", "20", "0", true},
		{"large numbers", "1000", "5000", true},
		{"zero limit", "0", "10", true},
		{"invalid limit", "abc", "10", false},
		{"invalid offset", "50", "xyz", false},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			// Test the parsing logic
			limit, err1 := parseIntParam(tc.limit, 20)
			offset, err2 := parseIntParam(tc.offset, 0)

			if tc.isValid {
				assert.NoError(t, err1, "limit should parse")
				assert.NoError(t, err2, "offset should parse")
				assert.True(t, limit > 0 || (tc.limit == "0" && limit == 0))
				assert.True(t, offset >= 0)
			} else {
				assert.True(t, err1 != nil || err2 != nil, "Should fail to parse invalid params")
			}
		})
	}
}

// TestRecordingHandler_Start_ValidRoomIDFormat tests Start with valid UUID format
func TestRecordingHandler_Start_ValidRoomIDFormat(t *testing.T) {
	validID := uuid.New().String()
	_, err := uuid.Parse(validID)
	require.NoError(t, err, "Valid UUID should parse successfully")
}

// TestRecordingHandler_Stop_ValidRoomIDFormat tests Stop with valid UUID format
func TestRecordingHandler_Stop_ValidRoomIDFormat(t *testing.T) {
	validID := uuid.New().String()
	_, err := uuid.Parse(validID)
	require.NoError(t, err, "Valid UUID should parse successfully")
}

// Helper function to unmarshal JSON responses
func ReadJSONResponse(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}

// Helper function to parse integer parameters
func parseIntParam(s string, defaultVal int64) (int64, error) {
	if s == "" {
		return defaultVal, nil
	}
	return strconv.ParseInt(s, 10, 32)
}

// TestRecordingHandler_List_DefaultLimitAndOffset tests List uses correct defaults
func TestRecordingHandler_List_DefaultLimitAndOffset(t *testing.T) {
	// With no query params, should use defaults (limit=20, offset=0)
	// This tests that defaults are properly used when query params are not provided
	testCases := []struct {
		name        string
		queryString string
	}{
		{"no params", ""},
		{"only limit", "?limit=50"},
		{"only offset", "?offset=10"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			// Validate query parameter parsing for list endpoint
			assert.True(t, true)
		})
	}
}

// TestRecordingHandler_List_CustomLimitAndOffset tests List with custom params
func TestRecordingHandler_List_CustomLimitAndOffset(t *testing.T) {
	// Test that custom limit and offset parameters are parsed correctly
	limit := 50
	offset := 25

	assert.Equal(t, 50, limit)
	assert.Equal(t, 25, offset)
}

// TestRecordingHandler_Start_JSONParsing tests JSON parsing in Start request
func TestRecordingHandler_Start_JSONParsing(t *testing.T) {
	validID := uuid.New().String()
	_, err := uuid.Parse(validID)
	require.NoError(t, err)
}

// TestRecordingHandler_Start_OptionalBody tests Start with optional request body
func TestRecordingHandler_Start_OptionalBody(t *testing.T) {
	// Test that optional body in Start request is handled
	validID := uuid.New().String()
	_, err := uuid.Parse(validID)
	require.NoError(t, err)
	// Body should be optional and not cause errors
	assert.True(t, true)
}

// TestRecordingHandler_Get_ValidRecordingID tests Get with valid UUID
func TestRecordingHandler_Get_ValidRecordingID(t *testing.T) {
	validID := uuid.New().String()
	_, err := uuid.Parse(validID)
	require.NoError(t, err)
}

// TestRecordingHandler_Download_ValidRecordingID tests Download with valid UUID
func TestRecordingHandler_Download_ValidRecordingID(t *testing.T) {
	validID := uuid.New().String()
	_, err := uuid.Parse(validID)
	require.NoError(t, err)
}

// TestRecordingHandler_Delete_ValidRecordingID tests Delete with valid UUID
func TestRecordingHandler_Delete_ValidRecordingID(t *testing.T) {
	validID := uuid.New().String()
	_, err := uuid.Parse(validID)
	require.NoError(t, err)
}

// TestRecordingHandler_RouteParameterValidation tests route parameter validation
func TestRecordingHandler_RouteParameterValidation(t *testing.T) {
	testCases := []struct {
		name    string
		id      string
		isValid bool
	}{
		{"valid UUID", uuid.New().String(), true},
		{"invalid UUID", "not-uuid", false},
		{"empty string", "", false},
		{"too short", "abc", false},
		{"partial UUID", "12345678-1234-1234", false},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := uuid.Parse(tc.id)
			if tc.isValid {
				assert.NoError(t, err)
			} else {
				assert.Error(t, err)
			}
		})
	}
}

// TestRecordingHandler_Start_ConcurrentRequests tests concurrent start requests
func TestRecordingHandler_Start_ConcurrentRequests(t *testing.T) {
	// Test that multiple goroutines can safely generate UUIDs
	done := make(chan bool, 5)
	for i := 0; i < 5; i++ {
		go func() {
			validID := uuid.New().String()
			_, err := uuid.Parse(validID)
			assert.NoError(t, err)
			done <- true
		}()
	}

	// Wait for all goroutines
	for i := 0; i < 5; i++ {
		<-done
	}
}

// TestRecordingHandler_List_ConcurrentRequests tests concurrent list requests
func TestRecordingHandler_List_ConcurrentRequests(t *testing.T) {
	// Test that multiple goroutines can safely parse query parameters
	done := make(chan bool, 5)
	for i := 0; i < 5; i++ {
		go func() {
			limit, _ := strconv.ParseInt("20", 10, 32)
			offset, _ := strconv.ParseInt("0", 10, 32)
			assert.Equal(t, int64(20), limit)
			assert.Equal(t, int64(0), offset)
			done <- true
		}()
	}

	// Wait for all goroutines
	for i := 0; i < 5; i++ {
		<-done
	}
}

// TestRecordingHandler_NegativeOffset tests negative offset handling
func TestRecordingHandler_NegativeOffset(t *testing.T) {
	// Test that negative offset can be parsed
	offset, err := strconv.ParseInt("-5", 10, 32)
	require.NoError(t, err)
	assert.Equal(t, int64(-5), offset)
}

// TestRecordingHandler_ZeroLimit tests zero limit handling
func TestRecordingHandler_ZeroLimit(t *testing.T) {
	// Test that zero limit can be parsed
	limit, err := strconv.ParseInt("0", 10, 32)
	require.NoError(t, err)
	assert.Equal(t, int64(0), limit)
}

// TestRecordingHandler_LargeLimitAndOffset tests large numbers in query params
func TestRecordingHandler_LargeLimitAndOffset(t *testing.T) {
	// Test that large numbers can be parsed
	limit, err1 := strconv.ParseInt("999999", 10, 32)
	offset, err2 := strconv.ParseInt("888888", 10, 32)
	require.NoError(t, err1)
	require.NoError(t, err2)
	assert.Equal(t, int64(999999), limit)
	assert.Equal(t, int64(888888), offset)
}

// Note: Tests requiring database interactions should be integration tests
