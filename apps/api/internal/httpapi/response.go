package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string, message string) {
	observability.RecordErrorCode(w, code)
	writeJSON(w, status, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

func cloneSignedHeaders(signed objectstorage.SignedURL) map[string][]string {
	cloned := make(map[string][]string, len(signed.SignedHeader))
	for name, values := range signed.SignedHeader {
		cloned[name] = append([]string{}, values...)
	}
	return cloned
}
