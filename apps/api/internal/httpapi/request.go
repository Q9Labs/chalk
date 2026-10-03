package httpapi

import (
	"encoding/json"
	"net/http"
)

const maxRequestBodyBytes = 1 << 20

func decodeRequestWithLimit(r *http.Request, target any, limit int64) error {
	r.Body = http.MaxBytesReader(nil, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}
