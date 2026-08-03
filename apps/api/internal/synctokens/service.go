package synctokens

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var ErrInvalidInput = errors.New("invalid sync token input")
var ErrSubjectNotFound = errors.New("sync token subject not found")

const Lifetime = 5 * time.Minute

type Config struct {
	Issuer     string
	Audience   string
	KeyID      string
	PrivateKey ed25519.PrivateKey
	Now        func() time.Time
}

type Input struct {
	TenantID                   utilities.ID
	SpaceID                    utilities.ID
	EpisodeID                  utilities.ID
	ParticipantID              utilities.ID
	ParticipantGeneration      int64
	AdmissionLifecycleIntentID utilities.ID
	DisplayName                string
	Role                       string
	Capabilities               []string
}

type Token struct {
	Value     string
	ExpiresAt time.Time
}

type SubjectKey struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
}

type SubjectRepository interface {
	GetSyncTokenSubject(context.Context, SubjectKey) (Input, error)
}

type Broker struct {
	repository SubjectRepository
	signer     Service
}

type Service struct {
	config Config
}

func NewService(config Config) (Service, error) {
	config.Issuer = strings.TrimSpace(config.Issuer)
	config.Audience = strings.TrimSpace(config.Audience)
	config.KeyID = strings.TrimSpace(config.KeyID)
	if config.Issuer == "" || config.Audience == "" || config.KeyID == "" || len(config.PrivateKey) != ed25519.PrivateKeySize {
		return Service{}, ErrInvalidInput
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return Service{config: config}, nil
}

func NewBroker(repository SubjectRepository, signer Service) Broker {
	return Broker{repository: repository, signer: signer}
}

func (b Broker) Issue(ctx context.Context, input Input) (Token, error) {
	return b.signer.Issue(ctx, input)
}

func (b Broker) IssueForParticipant(ctx context.Context, key SubjectKey) (Token, error) {
	if key.TenantID.IsZero() || key.SpaceID.IsZero() || key.EpisodeID.IsZero() || key.ParticipantID.IsZero() {
		return Token{}, ErrInvalidInput
	}
	input, err := b.repository.GetSyncTokenSubject(ctx, key)
	if err != nil {
		return Token{}, err
	}
	return b.signer.Issue(ctx, input)
}

func (s Service) Issue(_ context.Context, input Input) (Token, error) {
	if input.TenantID.IsZero() || input.SpaceID.IsZero() || input.EpisodeID.IsZero() || input.ParticipantID.IsZero() || input.AdmissionLifecycleIntentID.IsZero() || input.ParticipantGeneration <= 0 || !validDisplayName(input.DisplayName) || !validRole(input.Role) || !validCapabilities(input.Capabilities) {
		return Token{}, ErrInvalidInput
	}

	now := s.config.Now().UTC().Truncate(time.Second)
	expiresAt := now.Add(Lifetime)
	jti, err := randomID()
	if err != nil {
		return Token{}, fmt.Errorf("create sync token id: %w", err)
	}

	header, err := encode(map[string]string{"alg": "EdDSA", "kid": s.config.KeyID, "typ": "JWT"})
	if err != nil {
		return Token{}, fmt.Errorf("encode sync token header: %w", err)
	}
	claims, err := encode(map[string]any{
		"iss":                           s.config.Issuer,
		"aud":                           s.config.Audience,
		"sub":                           input.ParticipantID.String(),
		"jti":                           jti,
		"iat":                           now.Unix(),
		"nbf":                           now.Unix(),
		"exp":                           expiresAt.Unix(),
		"tenant_id":                     input.TenantID.String(),
		"space_id":                      input.SpaceID.String(),
		"episode_id":                    input.EpisodeID.String(),
		"participant_id":                input.ParticipantID.String(),
		"participant_generation":        input.ParticipantGeneration,
		"admission_lifecycle_intent_id": input.AdmissionLifecycleIntentID.String(),
		"display_name":                  input.DisplayName,
		"role":                          input.Role,
		"capabilities":                  append([]string{}, input.Capabilities...),
	})
	if err != nil {
		return Token{}, fmt.Errorf("encode sync token claims: %w", err)
	}

	signingInput := header + "." + claims
	signature := ed25519.Sign(s.config.PrivateKey, []byte(signingInput))
	return Token{Value: signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), ExpiresAt: expiresAt}, nil
}

func validDisplayName(value string) bool {
	return value != "" && utf8.ValidString(value) && len(value) <= 256
}

func validRole(value string) bool {
	return value != "" && strings.TrimSpace(value) == value && utf8.ValidString(value) && len(value) <= 128
}

var validCapabilityNames = map[string]struct{}{
	"publishAudio": {}, "publishVideo": {}, "publishScreen": {}, "subscribe": {}, "raiseHand": {}, "renameSelf": {},
	"sendChat": {}, "sendReaction": {}, "drawWhiteboard": {}, "manageWhiteboard": {}, "manageAdmission": {}, "assignRoles": {},
	"muteOthers": {}, "stopVideoOthers": {}, "stopScreenOthers": {}, "requestMediaOthers": {}, "removeParticipant": {},
	"manageRecording": {}, "startEpisode": {}, "extendEpisode": {}, "endEpisode": {}, "manageMembers": {}, "clearSpaceContent": {},
}

func validCapabilities(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value == "" || strings.TrimSpace(value) != value || !utf8.ValidString(value) || len(value) > 128 {
			return false
		}
		if _, known := validCapabilityNames[value]; !known {
			return false
		}
		if _, exists := seen[value]; exists {
			return false
		}
		seen[value] = struct{}{}
	}
	return true
}

func encode(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}

func randomID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}
