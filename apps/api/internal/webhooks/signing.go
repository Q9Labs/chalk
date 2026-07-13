package webhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strconv"
	"strings"
	"time"
)

func SignatureHeader(eventID string, occurredAt time.Time, body []byte, secrets ...[]byte) (string, string) {
	timestamp := strconv.FormatInt(occurredAt.Unix(), 10)
	message := make([]byte, 0, len(eventID)+len(timestamp)+len(body)+2)
	message = append(message, eventID...)
	message = append(message, '.')
	message = append(message, timestamp...)
	message = append(message, '.')
	message = append(message, body...)
	signatures := make([]string, 0, len(secrets))
	for _, secret := range secrets {
		mac := hmac.New(sha256.New, secret)
		_, _ = mac.Write(message)
		signatures = append(signatures, "v1,"+base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	}
	return timestamp, strings.Join(signatures, " ")
}
