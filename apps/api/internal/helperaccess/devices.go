package helperaccess

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"errors"
	"strings"
	"time"
	"unicode"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var ErrDeviceUnavailable = errors.New("Helper device request unavailable")

type DeviceRepository interface {
	StartDeviceRequest(context.Context, DeviceEnrollment) error
	LookupDeviceRequest(context.Context, utilities.ID, [32]byte) (DeviceOffer, error)
	ApproveDeviceRequest(context.Context, utilities.ID, utilities.ID, DeviceShare, bool) error
	PollDeviceRequest(context.Context, [32]byte) (*DeviceApproval, error)
	ListHelperDevices(context.Context, utilities.ID) ([]Device, error)
	RevokeHelperDevice(context.Context, utilities.ID, utilities.ID) error
}

type DeviceEnrollment struct {
	ID                                 utilities.ID
	CodeHash, PollHash, CredentialHash [32]byte
	Name, PublicKey                    string
	Registered                         bool
}

type DeviceShare struct {
	Subject accessgrants.Subject
	Binding Binding
}

type DeviceApproval struct {
	Share     DeviceShare
	ExpiresAt time.Time
}

type DeviceOffer struct {
	RequestID   string `json:"requestId"`
	Name        string `json:"name"`
	Fingerprint string `json:"fingerprint"`
}

type Device struct {
	ID   string `json:"deviceId"`
	Name string `json:"name"`
}

type DeviceCode struct {
	Code            string `json:"code"`
	IntervalSeconds int    `json:"intervalSeconds"`
}

type DevicePoll struct {
	Attachment *Ticket `json:"attachment,omitempty"`
}

var codeEncoding = base32.NewEncoding("ABCDEFGHJKLMNPQRSTUVWXYZ23456789").WithPadding(base32.NoPadding)

func (s *Service) StartDevice(ctx context.Context, name, key, credential, pollSecret string, registered bool) (DeviceCode, error) {
	name = strings.TrimSpace(name)
	if !validSecret(key) || !validSecret(credential) || !validSecret(pollSecret) ||
		credential == pollSecret || name == "" || len(name) > 96 ||
		strings.ContainsFunc(name, func(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) }) {
		return DeviceCode{}, ErrInvalid
	}
	id, err := utilities.NewID()
	if err != nil {
		return DeviceCode{}, err
	}
	var raw [5]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return DeviceCode{}, err
	}
	code := codeEncoding.EncodeToString(raw[:])
	err = s.devices.StartDeviceRequest(ctx, DeviceEnrollment{
		ID: id, Name: name, PublicKey: key, Registered: registered,
		CodeHash: sha256.Sum256([]byte(code)), PollHash: sha256.Sum256([]byte(pollSecret)),
		CredentialHash: sha256.Sum256([]byte(credential)),
	})
	return DeviceCode{Code: code[:4] + "-" + code[4:], IntervalSeconds: 3}, err
}

func (s *Service) LookupDevice(ctx context.Context, tenant utilities.ID, code string) (DeviceOffer, error) {
	code = strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))
	if _, err := codeEncoding.DecodeString(code); len(code) != 8 || err != nil {
		return DeviceOffer{}, ErrDeviceUnavailable
	}
	offer, err := s.devices.LookupDeviceRequest(ctx, tenant, sha256.Sum256([]byte(code)))
	if err != nil {
		return DeviceOffer{}, err
	}
	// The Helper displays the same fingerprint using its local key and short code.
	hash := sha256.Sum256([]byte(offer.Fingerprint + "\n" + code))
	offer.Fingerprint = codeEncoding.EncodeToString(hash[:5])
	return offer, nil
}

func (s *Service) ApproveDevice(ctx context.Context, tenant, request utilities.ID, subject accessgrants.Subject, layer utilities.ID, publication string, refresh bool) error {
	if tenant != subject.TenantID {
		return ErrShareNotCurrent
	}
	binding := Binding{LayerID: layer, PublicationID: publication}
	if err := s.authorizeShare(ctx, subject, binding); err != nil {
		return err
	}
	return s.devices.ApproveDeviceRequest(ctx, tenant, request, DeviceShare{Subject: subject, Binding: binding}, refresh)
}

func (s *Service) PollDevice(ctx context.Context, pollSecret string) (DevicePoll, error) {
	if !validSecret(pollSecret) {
		return DevicePoll{}, ErrInvalid
	}
	approval, err := s.devices.PollDeviceRequest(ctx, sha256.Sum256([]byte(pollSecret)))
	if err != nil || approval == nil {
		return DevicePoll{}, err
	}
	if err := s.authorize(ctx, approval.Share.Subject, approval.Share.Binding); err != nil {
		return DevicePoll{}, err
	}
	now := s.now().UTC()
	expires := approval.ExpiresAt.Truncate(time.Second)
	if !expires.After(now.Add(4 * time.Second)) {
		return DevicePoll{}, nil
	}
	ticket, err := s.remoteTicketUntil(approval.Share.Subject, approval.Share.Binding, now, expires)
	return DevicePoll{Attachment: &ticket}, err
}

func (s *Service) ListDevices(ctx context.Context, tenant utilities.ID) ([]Device, error) {
	return s.devices.ListHelperDevices(ctx, tenant)
}

func (s *Service) RevokeDevice(ctx context.Context, tenant, device utilities.ID) error {
	return s.devices.RevokeHelperDevice(ctx, tenant, device)
}
