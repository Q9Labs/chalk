package publicinvites

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	TokenVersion  = "cspi1"
	TokenAudience = "chalk-space-public-invite"
	TokenMaxBytes = 512
	HandleBytes   = 32
)

var (
	ErrInvalidToken      = errors.New("invalid public invite token")
	ErrUnknownKey        = errors.New("unknown public invite signing key")
	ErrInvalidKeyring    = errors.New("invalid public invite signing keyring")
	ErrInvalidHandle     = errors.New("invalid public invite handle")
	ErrInvalidGeneration = errors.New("invalid public invite generation")
	ErrInvalidKeyID      = errors.New("invalid public invite key id")
	ErrInvalidPayload    = errors.New("invalid public invite token payload")
	ErrTokenTooLarge     = errors.New("public invite token is too large")
)

// Keyring contains one signer and the explicit verification keys that remain
// valid during a key rollover. The signer is never exposed to callers.
type Keyring struct {
	CurrentKeyID string
	Signer       ed25519.PrivateKey
	Verifiers    map[string]ed25519.PublicKey
}

// Token is the authenticated capability-bearing cspi1 value. Tenant and Space
// are always resolved from the persistence row keyed by Handle.
type Token struct {
	KeyID      string
	Handle     []byte
	Generation uint64
}

type payload struct {
	Version    string `json:"version"`
	Audience   string `json:"audience"`
	Handle     string `json:"handle"`
	Generation uint64 `json:"generation"`
}

type Signer struct {
	keyring Keyring
}

// Verifier validates tokens against explicitly configured public keys. Keeping
// verification separate from signing lets an API process accept a previous
// key during rollover without holding its private key.
type Verifier struct {
	verifiers map[string]ed25519.PublicKey
}

func NewSigner(keyring Keyring) (Signer, error) {
	if err := validateKeyring(keyring); err != nil {
		return Signer{}, err
	}
	return Signer{keyring: copyKeyring(keyring)}, nil
}

func NewVerifier(verifiers map[string]ed25519.PublicKey) (Verifier, error) {
	if len(verifiers) == 0 {
		return Verifier{}, ErrInvalidKeyring
	}
	copy := make(map[string]ed25519.PublicKey, len(verifiers))
	for keyID, key := range verifiers {
		if err := validateKeyID(keyID); err != nil || len(key) != ed25519.PublicKeySize {
			return Verifier{}, ErrInvalidKeyring
		}
		copy[keyID] = append(ed25519.PublicKey(nil), key...)
	}
	return Verifier{verifiers: copy}, nil
}

func (s Signer) IssueRandom(generation uint64) (Token, string, error) {
	handle := make([]byte, HandleBytes)
	if _, err := rand.Read(handle); err != nil {
		return Token{}, "", fmt.Errorf("generate public invite handle: %w", err)
	}
	token, err := s.Issue(handle, generation)
	if err != nil {
		return Token{}, "", err
	}
	encoded, err := s.Encode(token)
	if err != nil {
		return Token{}, "", err
	}
	return token, encoded, nil
}

func (s Signer) Issue(handle []byte, generation uint64) (Token, error) {
	if len(handle) != HandleBytes {
		return Token{}, ErrInvalidHandle
	}
	if generation == 0 {
		return Token{}, ErrInvalidGeneration
	}
	return Token{
		KeyID:      s.keyring.CurrentKeyID,
		Handle:     append([]byte(nil), handle...),
		Generation: generation,
	}, nil
}

func (s Signer) Encode(token Token) (string, error) {
	if token.KeyID != s.keyring.CurrentKeyID {
		return "", ErrUnknownKey
	}
	if len(token.Handle) != HandleBytes {
		return "", ErrInvalidHandle
	}
	if token.Generation == 0 {
		return "", ErrInvalidGeneration
	}
	if err := validateKeyID(token.KeyID); err != nil {
		return "", err
	}
	payloadBytes, err := json.Marshal(payload{
		Version:    TokenVersion,
		Audience:   TokenAudience,
		Handle:     base64.RawURLEncoding.EncodeToString(token.Handle),
		Generation: token.Generation,
	})
	if err != nil {
		return "", fmt.Errorf("encode public invite payload: %w", err)
	}
	payloadSegment := base64.RawURLEncoding.EncodeToString(payloadBytes)
	message := strings.Join([]string{TokenVersion, token.KeyID, payloadSegment}, ".")
	signature := ed25519.Sign(s.keyring.Signer, []byte(message))
	encoded := message + "." + base64.RawURLEncoding.EncodeToString(signature)
	if len(encoded) > TokenMaxBytes {
		return "", ErrTokenTooLarge
	}
	return encoded, nil
}

func (s Signer) Verify(raw string) (Token, error) {
	verifier, err := NewVerifier(s.keyring.Verifiers)
	if err != nil {
		return Token{}, err
	}
	return verifier.Verify(raw)
}

func (v Verifier) Verify(raw string) (Token, error) {
	if len(raw) == 0 || len(raw) > TokenMaxBytes || !isASCII(raw) {
		return Token{}, ErrInvalidToken
	}
	segments := strings.Split(raw, ".")
	if len(segments) != 4 || segments[0] != TokenVersion || !validBase64URLSegment(segments[2]) || !validBase64URLSegment(segments[3]) {
		return Token{}, ErrInvalidToken
	}
	keyID := segments[1]
	if validateKeyID(keyID) != nil {
		return Token{}, ErrInvalidToken
	}
	key, ok := v.verifiers[keyID]
	if !ok {
		return Token{}, ErrUnknownKey
	}
	payloadBytes, ok := decodeBase64URLSegment(segments[2])
	if !ok {
		return Token{}, ErrInvalidToken
	}
	signature, ok := decodeBase64URLSegment(segments[3])
	if !ok || len(signature) != ed25519.SignatureSize {
		return Token{}, ErrInvalidToken
	}
	message := strings.Join(segments[:3], ".")
	if !ed25519.Verify(key, []byte(message), signature) {
		return Token{}, ErrInvalidToken
	}

	var decoded payload
	decoder := json.NewDecoder(bytes.NewReader(payloadBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return Token{}, ErrInvalidPayload
	}
	var trailing struct{}
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Token{}, ErrInvalidPayload
	}
	if decoded.Version != TokenVersion || decoded.Audience != TokenAudience || decoded.Generation == 0 || decoded.Handle == "" {
		return Token{}, ErrInvalidPayload
	}
	handle, ok := decodeBase64URLSegment(decoded.Handle)
	if !ok || len(handle) != HandleBytes {
		return Token{}, ErrInvalidPayload
	}
	return Token{KeyID: keyID, Handle: handle, Generation: decoded.Generation}, nil
}

func validateKeyring(keyring Keyring) error {
	if err := validateKeyID(keyring.CurrentKeyID); err != nil {
		return err
	}
	if len(keyring.Signer) != ed25519.PrivateKeySize || len(keyring.Verifiers) == 0 {
		return ErrInvalidKeyring
	}
	current, ok := keyring.Verifiers[keyring.CurrentKeyID]
	if !ok || len(current) != ed25519.PublicKeySize {
		return ErrInvalidKeyring
	}
	publicKey, ok := keyring.Signer.Public().(ed25519.PublicKey)
	if !ok || !ed25519.PublicKey(current).Equal(publicKey) {
		return ErrInvalidKeyring
	}
	for keyID, key := range keyring.Verifiers {
		if validateKeyID(keyID) != nil || len(key) != ed25519.PublicKeySize {
			return ErrInvalidKeyring
		}
	}
	return nil
}

func copyKeyring(keyring Keyring) Keyring {
	verifiers := make(map[string]ed25519.PublicKey, len(keyring.Verifiers))
	for keyID, key := range keyring.Verifiers {
		verifiers[keyID] = append(ed25519.PublicKey(nil), key...)
	}
	return Keyring{
		CurrentKeyID: keyring.CurrentKeyID,
		Signer:       append(ed25519.PrivateKey(nil), keyring.Signer...),
		Verifiers:    verifiers,
	}
}

func validateKeyID(keyID string) error {
	if keyID == "" || len(keyID) > 32 || !isASCII(keyID) || strings.ContainsAny(keyID, ".\r\n") {
		return ErrInvalidKeyID
	}
	for _, character := range keyID {
		if (character < 'A' || character > 'Z') &&
			(character < 'a' || character > 'z') &&
			(character < '0' || character > '9') && character != '_' && character != '-' {
			return ErrInvalidKeyID
		}
	}
	return nil
}

func validBase64URLSegment(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if (character < 'A' || character > 'Z') &&
			(character < 'a' || character > 'z') &&
			(character < '0' || character > '9') && character != '_' && character != '-' {
			return false
		}
	}
	return true
}

func decodeBase64URLSegment(value string) ([]byte, bool) {
	if !validBase64URLSegment(value) {
		return nil, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return nil, false
	}
	return decoded, true
}

func isASCII(value string) bool {
	for index := 0; index < len(value); index++ {
		if value[index] > 0x7f {
			return false
		}
	}
	return true
}
