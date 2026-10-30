package httpapi

import (
	"net/http"

	"github.com/q9labs/chalk/platform/httpcontract"
	"github.com/q9labs/chalk/platform/objectstorage"
)

func writeJSON(w http.ResponseWriter, status int, value any) {
	httpcontract.WriteJSON(w, status, value)
}
func writeError(w http.ResponseWriter, status int, code string, message string) {
	httpcontract.WriteAPIError(w, httpcontract.APIError{Status: status, Code: code, Message: message})
}

func cloneSignedHeaders(signed objectstorage.SignedURL) map[string][]string {
	cloned := make(map[string][]string, len(signed.SignedHeader))
	for name, values := range signed.SignedHeader {
		cloned[name] = append([]string{}, values...)
	}
	return cloned
}
