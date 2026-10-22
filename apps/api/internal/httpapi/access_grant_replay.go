package httpapi

import (
	"encoding/json"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
)

func decodeAccessGrantReplay(token string, ciphertext []byte) (accessGrantResponse, bool, error) {
	body, err := accessgrants.OpenRefreshReplay(token, ciphertext)
	if err != nil {
		return accessGrantResponse{}, false, err
	}
	var response accessGrantResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return accessGrantResponse{}, false, err
	}
	mediaExpiry, err := time.Parse(time.RFC3339, response.Media.ExpiresAt)
	if err != nil {
		return accessGrantResponse{}, false, err
	}
	syncExpiry, err := time.Parse(time.RFC3339, response.Sync.ExpiresAt)
	if err != nil {
		return accessGrantResponse{}, false, err
	}
	now := time.Now()
	return response, mediaExpiry.After(now) && syncExpiry.After(now), nil
}
