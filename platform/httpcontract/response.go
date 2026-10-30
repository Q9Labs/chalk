package httpcontract

import (
	"encoding/json"
	"net/http"
	"strings"
)

func WriteJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func WriteAPIError(w http.ResponseWriter, err APIError) {
	WriteJSON(w, err.Status, map[string]any{"error": map[string]string{"code": err.Code, "message": err.Message}})
}
func BearerToken(header string) (string, bool) {
	scheme, token, found := strings.Cut(strings.TrimSpace(header), " ")
	token = strings.TrimSpace(token)
	if !found || !strings.EqualFold(scheme, "Bearer") || token == "" {
		return "", false
	}
	return token, true
}

var (
	ErrorUnauthenticated    = APIError{Status: http.StatusUnauthorized, Code: "access.unauthenticated", Message: "Authentication required"}
	ErrorForbidden          = APIError{Status: http.StatusForbidden, Code: "access.forbidden", Message: "Access denied"}
	ErrorServiceUnavailable = APIError{Status: http.StatusServiceUnavailable, Code: "service.unavailable", Message: "Service is not ready"}
	ErrorRateLimited        = APIError{Status: http.StatusTooManyRequests, Code: "request.rate_limited", Message: "Too many requests"}
)
