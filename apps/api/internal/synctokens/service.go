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
	RoomID                     utilities.ID
	SessionID                  utilities.ID
	ParticipantID              utilities.ID
	ParticipantGeneration      int64
	AdmissionLifecycleIntentID utilities.ID
	DisplayName                string
	InitialRole                string
	EligibleRoles              []string
}

type Token struct {
	Value     string
	ExpiresAt time.Time
}

type SubjectKey struct {
	TenantID      utilities.ID
	RoomID        utilities.ID
	SessionID     utilities.ID
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
	if key.TenantID.IsZero() || key.RoomID.IsZero() || key.SessionID.IsZero() || key.ParticipantID.IsZero() {
		return Token{}, ErrInvalidInput
	}
	input, err := b.repository.GetSyncTokenSubject(ctx, key)
	if err != nil {
		return Token{}, err
	}
	return b.signer.Issue(ctx, input)
}

func (s Service) Issue(_ context.Context, input Input) (Token, error) {
	eligibleRoles, ok := canonicalAuthorityEnvelope(input.InitialRole, input.EligibleRoles)
	if input.TenantID.IsZero() || input.RoomID.IsZero() || input.SessionID.IsZero() || input.ParticipantID.IsZero() || input.AdmissionLifecycleIntentID.IsZero() || input.ParticipantGeneration <= 0 || !validDisplayName(input.DisplayName) || !ok {
		return Token{}, ErrInvalidInput
	}
	input.EligibleRoles = eligibleRoles

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
		"iss":                            s.config.Issuer,
		"aud":                            s.config.Audience,
		"sub":                            input.ParticipantID.String(),
		"jti":                            jti,
		"iat":                            now.Unix(),
		"nbf":                            now.Unix(),
		"exp":                            expiresAt.Unix(),
		"tenant_id":                      input.TenantID.String(),
		"room_id":                        input.RoomID.String(),
		"session_id":                     input.SessionID.String(),
		"participant_id":                 input.ParticipantID.String(),
		"participant_session_id":         input.ParticipantID.String(),
		"participant_session_generation": input.ParticipantGeneration,
		"admission_lifecycle_intent_id":  input.AdmissionLifecycleIntentID.String(),
		"display_name":                   input.DisplayName,
		"initial_role":                   input.InitialRole,
		"eligible_roles":                 append([]string(nil), input.EligibleRoles...),
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

func canonicalAuthorityEnvelope(initialRole string, eligibleRoles []string) ([]string, bool) {
	roles := map[string]struct{}{"host": {}, "cohost": {}, "participant": {}}
	if _, ok := roles[initialRole]; !ok || len(eligibleRoles) == 0 || len(eligibleRoles) > len(roles) {
		return nil, false
	}
	seen := make(map[string]struct{}, len(eligibleRoles))
	for _, role := range eligibleRoles {
		if _, ok := roles[role]; !ok {
			return nil, false
		}
		if _, exists := seen[role]; exists {
			return nil, false
		}
		seen[role] = struct{}{}
	}
	if _, ok := seen[initialRole]; !ok {
		return nil, false
	}
	_, cohostEligible := seen["cohost"]
	if initialRole == "host" && !cohostEligible {
		return nil, false
	}
	result := make([]string, 0, len(seen))
	for _, role := range []string{"host", "cohost", "participant"} {
		if _, ok := seen[role]; ok {
			result = append(result, role)
		}
	}
	return result, true
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
