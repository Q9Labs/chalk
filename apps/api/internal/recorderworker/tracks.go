package recorderworker

import (
	"crypto/sha256"
	"encoding/hex"
)

func Checksum(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
