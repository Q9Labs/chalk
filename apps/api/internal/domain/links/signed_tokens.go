package links

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	ErrInvalidToken = errors.New("invalid token")
	ErrExpiredToken = errors.New("token expired")
)

type JoinTokenPayload struct {
	Type     string    `json:"typ"`
	Version  int       `json:"v"`
	TenantID uuid.UUID `json:"tenant_id"`
	RoomName string    `json:"room_name"`
	Expires  int64     `json:"exp"`
}

type ShareTokenPayload struct {
	Type       string    `json:"typ"`
	Version    int       `json:"v"`
	RecordingID uuid.UUID `json:"recording_id"`
	Expires    int64     `json:"exp"`
}

func SignJoinToken(secret []byte, tenantID uuid.UUID, roomName string, expiresAt time.Time) (string, error) {
	p := JoinTokenPayload{
		Type:     "join",
		Version:  1,
		TenantID: tenantID,
		RoomName: roomName,
		Expires:  expiresAt.Unix(),
	}
	return sign(secret, p)
}

func VerifyJoinToken(secret []byte, token string, now time.Time) (*JoinTokenPayload, error) {
	var p JoinTokenPayload
	if err := verify(secret, token, &p); err != nil {
		return nil, err
	}
	if p.Type != "join" || p.Version != 1 || p.TenantID == uuid.Nil || p.RoomName == "" {
		return nil, ErrInvalidToken
	}
	if now.Unix() > p.Expires {
		return nil, ErrExpiredToken
	}
	return &p, nil
}

func SignShareToken(secret []byte, recordingID uuid.UUID, expiresAt time.Time) (string, error) {
	p := ShareTokenPayload{
		Type:        "share",
		Version:     1,
		RecordingID: recordingID,
		Expires:     expiresAt.Unix(),
	}
	return sign(secret, p)
}

func VerifyShareToken(secret []byte, token string, now time.Time) (*ShareTokenPayload, error) {
	var p ShareTokenPayload
	if err := verify(secret, token, &p); err != nil {
		return nil, err
	}
	if p.Type != "share" || p.Version != 1 || p.RecordingID == uuid.Nil {
		return nil, ErrInvalidToken
	}
	if now.Unix() > p.Expires {
		return nil, ErrExpiredToken
	}
	return &p, nil
}

func sign(secret []byte, payload any) (string, error) {
	if len(secret) == 0 {
		return "", fmt.Errorf("missing signing secret")
	}

	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(raw)
	sig := mac.Sum(nil)

	enc := base64.RawURLEncoding
	return "v1." + enc.EncodeToString(raw) + "." + enc.EncodeToString(sig), nil
}

func verify(secret []byte, token string, out any) error {
	if len(secret) == 0 {
		return fmt.Errorf("missing signing secret")
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return ErrInvalidToken
	}

	enc := base64.RawURLEncoding
	raw, err := enc.DecodeString(parts[1])
	if err != nil {
		return ErrInvalidToken
	}
	sig, err := enc.DecodeString(parts[2])
	if err != nil {
		return ErrInvalidToken
	}

	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(raw)
	expected := mac.Sum(nil)
	if !hmac.Equal(sig, expected) {
		return ErrInvalidToken
	}

	if err := json.Unmarshal(raw, out); err != nil {
		return ErrInvalidToken
	}

	return nil
}

