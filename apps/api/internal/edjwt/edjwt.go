// Package edjwt verifies the signature and shape of compact EdDSA JWTs that the API issues.
// Callers check the claims; this package owns the parts that must stay identical across issuers.
package edjwt

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
)

const maxTokenBytes = 8 * 1024

// Keys holds verification keys by key ID.
type Keys map[string]ed25519.PublicKey

// NewKeys copies the keys and reports false when there are none, or when one has a blank or
// untrimmed key ID or a wrong-sized key.
func NewKeys(keys map[string]ed25519.PublicKey) (Keys, bool) {
	if len(keys) == 0 {
		return nil, false
	}
	copied := make(Keys, len(keys))
	for keyID, key := range keys {
		if keyID == "" || keyID != strings.TrimSpace(keyID) || len(key) != ed25519.PublicKeySize {
			return nil, false
		}
		copied[keyID] = append(ed25519.PublicKey(nil), key...)
	}
	return copied, true
}

// Errors names the error each failed check returns, so a caller keeps its own error values.
type Errors struct {
	Malformed  error
	Header     error
	UnknownKey error
	Signature  error
}

type header struct {
	Algorithm string `json:"alg"`
	Type      string `json:"typ"`
	KeyID     string `json:"kid"`
}

// Verify checks the token's structure, header and signature, then strictly decodes the claims
// into claims. Unknown claim fields and trailing data are rejected.
func (k Keys) Verify(token string, errs Errors, claims any) error {
	parts := strings.Split(token, ".")
	if token == "" || len(token) > maxTokenBytes || len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return errs.Malformed
	}
	var head header
	if decodePart(parts[0], &head) != nil || head.Algorithm != "EdDSA" || head.Type != "JWT" || head.KeyID == "" {
		return errs.Header
	}
	key, ok := k[head.KeyID]
	if !ok {
		return errs.UnknownKey
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature) {
		return errs.Signature
	}
	if decodePart(parts[1], claims) != nil {
		return errs.Malformed
	}
	return nil
}

func decodePart(part string, target any) error {
	encoded, err := base64.RawURLEncoding.DecodeString(part)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return io.ErrUnexpectedEOF
	}
	return nil
}
