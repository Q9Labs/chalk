// Package helperaccess issues credentials only for the current screen sharer.
package helperaccess

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalid         = errors.New("invalid Helper ticket request")
	ErrShareNotCurrent = errors.New("Helper attachment does not match the current share")
)

const (
	lifetime       = 60 * time.Second
	localAudience  = "screen_annotation_helper_local_v1"
	remoteAudience = "screen_annotation_helper_v1"
)

type Repository interface {
	CurrentAnnotationShare(context.Context, accessgrants.Subject, utilities.ID, string) (bool, error)
}

type Service struct {
	devices    DeviceRepository
	repository Repository
	issuer     string
	keyID      string
	key        ed25519.PrivateKey
	now        func() time.Time
}

func (s *Service) WithDevices(repository DeviceRepository) *Service {
	s.devices = repository
	return s
}

func (s *Service) DevicesEnabled() bool { return s != nil && s.devices != nil }

func NewService(repository Repository, issuer, keyID string, key ed25519.PrivateKey) *Service {
	return &Service{repository: repository, issuer: issuer, keyID: keyID, key: key, now: time.Now}
}

type Binding struct {
	LayerID       utilities.ID
	PublicationID string
	DeviceKey     string
}

type Ticket struct {
	Value       string `json:"ticket"`
	ExpiresAtMs int64  `json:"expiresAtMs"`
}

type LocalTickets struct {
	Pair       Ticket `json:"pair"`
	Attachment Ticket `json:"attachment"`
	Remembered bool   `json:"remembered,omitempty"`
}

func validSecret(value string) bool {
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return len(value) == 43 && err == nil && len(decoded) == 32
}

func (s *Service) IssueLocal(ctx context.Context, subject accessgrants.Subject, binding Binding, origin, challenge string, remembered bool) (LocalTickets, error) {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" ||
		origin != "https://"+parsed.Host || !validSecret(challenge) {
		return LocalTickets{}, ErrInvalid
	}
	if err := s.authorize(ctx, subject, binding); err != nil {
		return LocalTickets{}, err
	}
	if remembered && s.DevicesEnabled() {
		var tickets LocalTickets
		err := s.devices.WithActiveHelperLoopbackDevice(ctx, subject.TenantID, binding.DeviceKey, func() error {
			var err error
			tickets, err = s.localTickets(subject, binding, origin, challenge, true)
			return err
		})
		if err == nil {
			return tickets, nil
		}
		if !errors.Is(err, ErrDeviceUnavailable) {
			return LocalTickets{}, err
		}
	}
	return s.localTickets(subject, binding, origin, challenge, false)
}

func (s *Service) localTickets(subject accessgrants.Subject, binding Binding, origin, challenge string, remembered bool) (LocalTickets, error) {
	now := s.now().UTC()
	expires := now.Add(lifetime)
	claims := map[string]any{
		"aud": localAudience, "role": "sharer", "version": 1,
		"origin": origin, "challenge": challenge, "helperPublicKey": binding.DeviceKey,
		"tenantId": subject.TenantID.String(), "spaceId": subject.SpaceID.String(),
		"episodeId": subject.EpisodeID.String(), "participantId": subject.ParticipantID.String(),
		"generation": subject.ParticipantGeneration, "publicationId": binding.PublicationID,
		"layerId": binding.LayerID.String(), "expiresAtMs": expires.UnixMilli(),
	}
	if remembered {
		claims["remembered"] = true
	}
	local, err := s.sign(map[string]string{"alg": "EdDSA", "typ": "chalk-helper-pair-ticket+jwt"}, claims, expires)
	if err != nil {
		return LocalTickets{}, err
	}
	attachment, err := s.remoteTicket(subject, binding, now)
	if err != nil {
		return LocalTickets{}, err
	}
	return LocalTickets{Pair: local, Attachment: attachment, Remembered: remembered}, nil
}

func (s *Service) authorize(ctx context.Context, subject accessgrants.Subject, binding Binding) error {
	if !validSecret(binding.DeviceKey) {
		return ErrInvalid
	}
	return s.authorizeShare(ctx, subject, binding)
}

func (s *Service) authorizeShare(ctx context.Context, subject accessgrants.Subject, binding Binding) error {
	if binding.LayerID.IsZero() || len(binding.PublicationID) > 512 {
		return ErrInvalid
	}
	reference, err := mediapublications.ParseReference(binding.PublicationID)
	if err != nil || !reference.HasParticipantGeneration ||
		reference.ParticipantGeneration != subject.ParticipantGeneration || reference.ConnectionID != subject.ConnectionID {
		return ErrShareNotCurrent
	}
	current, err := s.repository.CurrentAnnotationShare(ctx, subject, binding.LayerID, binding.PublicationID)
	if err != nil {
		return err
	}
	if !current {
		return ErrShareNotCurrent
	}
	return nil
}

func (s *Service) remoteTicket(subject accessgrants.Subject, binding Binding, now time.Time) (Ticket, error) {
	return s.remoteTicketUntil(subject, binding, now, now.Truncate(time.Second).Add(lifetime))
}

func (s *Service) remoteTicketUntil(subject accessgrants.Subject, binding Binding, now, expires time.Time) (Ticket, error) {
	return s.sign(map[string]string{"alg": "EdDSA", "kid": s.keyID, "typ": "JWT"}, map[string]any{
		"iss": s.issuer, "aud": remoteAudience, "role": "sharer", "version": 1,
		"sub": subject.ParticipantID.String(), "tenant_id": subject.TenantID.String(),
		"space_id": subject.SpaceID.String(), "episode_id": subject.EpisodeID.String(),
		"participant_id": subject.ParticipantID.String(), "participant_generation": subject.ParticipantGeneration,
		"publication_id": binding.PublicationID, "layer_id": binding.LayerID.String(),
		"iat": now.Unix(), "nbf": now.Unix(), "exp": expires.Unix(),
		"cnf": map[string]any{"jwk": map[string]string{"kty": "OKP", "crv": "Ed25519", "x": binding.DeviceKey}},
	}, expires)
}

func (s *Service) sign(header map[string]string, claims map[string]any, expires time.Time) (Ticket, error) {
	protected, err := json.Marshal(header)
	if err != nil {
		return Ticket{}, err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return Ticket{}, err
	}
	input := base64.RawURLEncoding.EncodeToString(protected) + "." + base64.RawURLEncoding.EncodeToString(payload)
	signature := ed25519.Sign(s.key, []byte(input))
	return Ticket{Value: input + "." + base64.RawURLEncoding.EncodeToString(signature), ExpiresAtMs: expires.UnixMilli()}, nil
}
