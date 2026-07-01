package httpapi

import (
	"encoding/json"
	"net/http"
)

func decodeRequest(r *http.Request, target any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}
