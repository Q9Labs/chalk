package memberships

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/mail"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/email"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvitationUnavailable = errors.New("invitation is expired, revoked or already used; ask an Owner for a new invitation")
	ErrInvitationAccount     = errors.New("sign in with the account that owns the invited email")
	ErrInvalidEmail          = errors.New("invalid invitation email")
	ErrLastOwner             = errors.New("the last Owner cannot leave, be removed or change Role; add another Owner first")
)

type Invitation struct {
	ID        utilities.ID
	TenantID  utilities.ID
	Email     string
	Role      Role
	ExpiresAt time.Time
	CreatedAt time.Time
}
type IssueInvitationInput struct {
	ID        utilities.ID
	TenantID  utilities.ID
	Email     string
	Role      Role
	TokenHash string
	ExpiresAt time.Time
}
type InvitationResult struct {
	Invitation     Invitation
	AcceptLink     string
	EmailDelivered bool
}
type PeopleRepository interface {
	IssueInvitation(context.Context, IssueInvitationInput) (Invitation, error)
	ListInvitations(context.Context, utilities.ID) ([]Invitation, error)
	RevokeInvitation(context.Context, utilities.ID, utilities.ID) error
	AcceptInvitation(context.Context, string, utilities.ID) (Membership, error)
	RemoveMembership(context.Context, utilities.ID, utilities.ID) error
	LeaveTenant(context.Context, utilities.ID, utilities.ID) error
}
type PeopleService struct {
	repository PeopleRepository
	sender     email.Sender
	from       string
	webOrigin  string
}

func NewPeopleService(repository PeopleRepository, sender email.Sender, from, webOrigin string) PeopleService {
	return PeopleService{repository: repository, sender: sender, from: from, webOrigin: strings.TrimRight(webOrigin, "/")}
}
func (s PeopleService) IssueInvitation(ctx context.Context, tenantID utilities.ID, address string, role Role) (InvitationResult, error) {
	address = strings.ToLower(strings.TrimSpace(address))
	parsed, err := mail.ParseAddress(address)
	if err != nil || parsed.Address != address {
		return InvitationResult{}, ErrInvalidEmail
	}
	if !validRole(role) {
		return InvitationResult{}, ErrInvalidMembershipRole
	}
	if tenantID.IsZero() {
		return InvitationResult{}, ErrInvalidTenantID
	}
	id, err := utilities.NewID()
	if err != nil {
		return InvitationResult{}, err
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return InvitationResult{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(secret)
	invitation, err := s.repository.IssueInvitation(ctx, IssueInvitationInput{ID: id, TenantID: tenantID, Email: address, Role: role, TokenHash: InvitationTokenHash(token), ExpiresAt: time.Now().UTC().Add(7 * 24 * time.Hour)})
	if err != nil {
		return InvitationResult{}, err
	}
	result := InvitationResult{Invitation: invitation, AcceptLink: s.webOrigin + "/invitations/accept#token=" + token}
	if s.sender != nil && s.from != "" && s.webOrigin != "" {
		_, err = s.sender.SendEmail(ctx, email.SendEmailInput{From: s.from, To: []string{address}, Subject: "Your Tenant invitation", TextBody: "Sign in with this email to accept your Tenant invitation: " + result.AcceptLink + "\nThis invitation expires in 7 days.", IdempotencyKey: id.String()})
		// A delivery failure must not hide the valid invitation. The Owner can share its link.
		result.EmailDelivered = err == nil
	}
	return result, nil
}
func InvitationTokenHash(token string) string {
	hash := sha256.Sum256([]byte(token))
	return hex.EncodeToString(hash[:])
}
func (s PeopleService) ListInvitations(ctx context.Context, id utilities.ID) ([]Invitation, error) {
	return s.repository.ListInvitations(ctx, id)
}
func (s PeopleService) RevokeInvitation(ctx context.Context, tenant, id utilities.ID) error {
	return s.repository.RevokeInvitation(ctx, tenant, id)
}
func (s PeopleService) AcceptInvitation(ctx context.Context, token string, account utilities.ID) (Membership, error) {
	if len(token) != 43 || account.IsZero() {
		return Membership{}, ErrInvitationUnavailable
	}
	return s.repository.AcceptInvitation(ctx, InvitationTokenHash(token), account)
}
func (s PeopleService) RemoveMembership(ctx context.Context, tenant, id utilities.ID) error {
	return s.repository.RemoveMembership(ctx, tenant, id)
}
func (s PeopleService) LeaveTenant(ctx context.Context, tenant, account utilities.ID) error {
	return s.repository.LeaveTenant(ctx, tenant, account)
}
