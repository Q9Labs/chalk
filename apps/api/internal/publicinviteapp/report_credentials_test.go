package publicinviteapp_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type reportInviteRepository struct {
	publicinvites.Repository
	invite publicinvites.Invite
	err    error
}

func (r reportInviteRepository) GetInvite(_ context.Context, tenantID, spaceID utilities.ID) (publicinvites.Invite, error) {
	if tenantID != r.invite.TenantID || spaceID != r.invite.SpaceID {
		return publicinvites.Invite{}, publicinvites.ErrInviteNotFound
	}
	return r.invite, r.err
}

func TestReportCredentialsUsesLiveBoundInvite(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := publicinvites.NewSigner(publicinvites.Keyring{CurrentKeyID: "test", Signer: private, Verifiers: map[string]ed25519.PublicKey{"test": public}})
	if err != nil {
		t.Fatal(err)
	}
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustID(t, "22222222-2222-4222-8222-222222222222")
	invite := publicinvites.Invite{TenantID: tenantID, SpaceID: spaceID, Handle: make([]byte, publicinvites.HandleBytes), Generation: 2, StateEpoch: 1, PublicRole: publicinvites.PublicRoleCollaborator, AdmissionMode: publicinvites.AdmissionOpen}
	if _, err := rand.Read(invite.Handle); err != nil {
		t.Fatal(err)
	}
	service := publicinvites.NewService(reportInviteRepository{invite: invite}, signer)
	source := publicinviteapp.ReportCredentials{Service: service}
	subject := accessgrants.Subject{TenantID: tenantID, SpaceID: spaceID}
	credentials, err := source.Credentials(context.Background(), subject)
	if err != nil || len(credentials) != 1 {
		t.Fatal("live invite credential unavailable")
	}
	expected, err := service.IssueInviteToken(invite)
	if err != nil || credentials[0] != expected {
		t.Fatal("source did not return the current signed invite")
	}
	other := subject
	other.SpaceID = mustID(t, "33333333-3333-4333-8333-333333333333")
	credentials, err = source.Credentials(context.Background(), other)
	if err != nil || len(credentials) != 0 {
		t.Fatal("source leaked an unrelated Space credential")
	}
	source.Service = publicinvites.NewService(reportInviteRepository{invite: invite, err: errors.New("store unavailable")}, signer)
	if _, err := source.Credentials(context.Background(), subject); err == nil {
		t.Fatal("credential lookup failure hidden")
	}
}
