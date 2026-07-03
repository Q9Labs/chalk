package httpapi

import (
	"encoding/json"
	"net/http"
)

const maxRequestBodyBytes = 1 << 20

func decodeRequest(r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, maxRequestBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}
