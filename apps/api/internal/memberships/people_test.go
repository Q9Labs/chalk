package memberships

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/email"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type invitationRepositoryStub struct {
	PeopleRepository
	input      IssueInvitationInput
	calls      int
	afterIssue func()
}

func (r *invitationRepositoryStub) IssueInvitation(_ context.Context, input IssueInvitationInput) (Invitation, error) {
	r.input = input
	r.calls++
	if r.afterIssue != nil {
		r.afterIssue()
	}
	return Invitation{ID: input.ID, TenantID: input.TenantID, Email: input.Email, Role: input.Role, ExpiresAt: input.ExpiresAt}, nil
}

type invitationSenderStub struct {
	input  email.SendEmailInput
	err    error
	ctxErr error
}

func (s *invitationSenderStub) SendEmail(ctx context.Context, input email.SendEmailInput) (email.SendEmailResult, error) {
	s.input = input
	s.ctxErr = ctx.Err()
	return email.SendEmailResult{}, s.err
}
func TestIssueInvitationValidationLifetimeAndDelivery(t *testing.T) {
	tenant, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	for _, delivery := range []struct {
		name      string
		sender    *invitationSenderStub
		delivered bool
	}{
		{name: "no sender"}, {name: "sent", sender: &invitationSenderStub{}, delivered: true}, {name: "failed delivery", sender: &invitationSenderStub{err: email.ErrProviderFailed}},
	} {
		t.Run(delivery.name, func(t *testing.T) {
			repository := &invitationRepositoryStub{}
			var sender email.Sender
			if delivery.sender != nil {
				sender = delivery.sender
			}
			service := NewPeopleService(repository, sender, "Chalk <invitations@example.test>", "https://chalk.test")
			before := time.Now()
			result, err := service.IssueInvitation(context.Background(), tenant, " PERSON@EXAMPLE.TEST ", RoleCollaborator)
			if err != nil || result.EmailDelivered != delivery.delivered {
				t.Fatalf("result=%v err=%v", result, err)
			}
			if repository.input.Email != "person@example.test" || repository.input.ExpiresAt.Sub(before) < 7*24*time.Hour || repository.input.ExpiresAt.Sub(before) > 7*24*time.Hour+time.Second {
				t.Fatalf("input=%v", repository.input)
			}
			_, token, _ := strings.Cut(result.AcceptLink, "#token=")
			if len(token) != 43 || repository.input.TokenHash != InvitationTokenHash(token) || strings.Contains(repository.input.TokenHash, token) {
				t.Fatal("only a hash should be stored")
			}
			if delivery.sender != nil && (!strings.Contains(delivery.sender.input.TextBody, result.AcceptLink) || delivery.sender.input.To[0] != "person@example.test") {
				t.Fatal("email must include the link and invited email")
			}
			if _, err = service.IssueInvitation(context.Background(), tenant, "Display <person@example.test>", RoleOwner); !errors.Is(err, ErrInvalidEmail) {
				t.Fatalf("email error=%v", err)
			}
			if _, err = service.IssueInvitation(context.Background(), tenant, "person@example.test", Role("invalid")); !errors.Is(err, ErrInvalidMembershipRole) {
				t.Fatalf("role error=%v", err)
			}
			if repository.calls != 1 {
				t.Fatal("invalid input reached repository")
			}
		})
	}
}

func TestIssueInvitationAttemptsDeliveryAfterRequestCancellation(t *testing.T) {
	tenant, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	repository := &invitationRepositoryStub{afterIssue: cancel}
	sender := &invitationSenderStub{}
	service := NewPeopleService(repository, sender, "Chalk <invitations@example.test>", "https://chalk.test")

	result, err := service.IssueInvitation(ctx, tenant, "person@example.test", RoleCollaborator)
	if err != nil || !result.EmailDelivered {
		t.Fatalf("result=%v err=%v", result, err)
	}
	if sender.input.Subject == "" || sender.ctxErr != nil {
		t.Fatalf("delivery was not attempted with a live context: input=%v ctxErr=%v", sender.input, sender.ctxErr)
	}
}
