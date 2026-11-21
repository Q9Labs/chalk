package config

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// OperatorDiagnoseTokenSHA256Env names the SHA-256 (hex) of the token that lets an operator issue live
// introspection requests at /operator/diagnostics/live-requests. The token itself lives in CI and
// 1Password, never in api.env.
const OperatorDiagnoseTokenSHA256Env = "CHALK_OPERATOR_DIAGNOSE_TOKEN_SHA256"

// OperatorDiagnoseTokenSHA256 returns the configured hash, or nothing when it is unset or malformed.
// Nothing means the route answers 404, so an unset token closes introspection instead of opening it.
func OperatorDiagnoseTokenSHA256() []byte {
	decoded, err := hex.DecodeString(strings.TrimSpace(envOrDefault(OperatorDiagnoseTokenSHA256Env, "")))
	if err != nil || len(decoded) != sha256.Size {
		return nil
	}
	return decoded
}
