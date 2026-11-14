package config

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// OperatorReadTokenSHA256Env names the SHA-256 (hex) of the token that lets an operator read private figures, such
// as the live participant count, from /readyz. The token itself lives in CI and 1Password, never in api.env.
const OperatorReadTokenSHA256Env = "CHALK_OPERATOR_READ_TOKEN_SHA256"

// OperatorReadTokenSHA256 returns the configured hash, or nothing when it is unset or malformed. Nothing means no
// token is accepted, so a typo closes the figures instead of opening them.
func OperatorReadTokenSHA256() []byte {
	decoded, err := hex.DecodeString(strings.TrimSpace(envOrDefault(OperatorReadTokenSHA256Env, "")))
	if err != nil || len(decoded) != sha256.Size {
		return nil
	}
	return decoded
}
