package httpapi

import (
	"net/http"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func optionalQueryID(w http.ResponseWriter, r *http.Request, name string, code string, message string) (utilities.ID, bool) {
	value := strings.TrimSpace(r.URL.Query().Get(name))
	if value == "" {
		return utilities.ID{}, true
	}

	id, err := utilities.ParseID(value)
	if err != nil {
		writeError(w, http.StatusBadRequest, code, message)
		return utilities.ID{}, false
	}

	return id, true
}
