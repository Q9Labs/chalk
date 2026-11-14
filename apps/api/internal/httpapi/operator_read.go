package httpapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
)

// operatorReadAuthorized reports whether the request carries the operator read token whose SHA-256 is expected.
// Comparing hashes of equal length keeps the comparison constant time whatever the token looks like.
func operatorReadAuthorized(r *http.Request, expected []byte) bool {
	if len(expected) != sha256.Size {
		return false
	}
	token, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok {
		return false
	}
	actual := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(actual[:], expected) == 1
}
