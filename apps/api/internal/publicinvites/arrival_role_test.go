package publicinvites

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type starterStore struct {
	Repository
	starter Arrival
}

func (s starterStore) GetArrivalForCredential(_ context.Context, handle utilities.ID, hash []byte) (Arrival, error) {
	if handle != s.starter.ArrivalHandle || !bytes.Equal(hash, s.starter.GuestCredentialHash) {
		return Arrival{}, ErrArrivalNotFound
	}
	return s.starter, nil
}

type starterLifecycle struct {
	Lifecycle
	lifecycle AutoLifecycle
	err       error
}

func (l starterLifecycle) GetAutoLifecycle(context.Context, utilities.ID, utilities.ID) (AutoLifecycle, error) {
	return l.lifecycle, l.err
}

// Whoever starts a public call stays its owner when they arrive again after a Leave or a lost seat. A rejoin is a
// new arrival, so the starter is known by the credential of the arrival that created the Space.
func TestArrivalRoleKeepsTheStarterAsOwner(t *testing.T) {
	secret := bytes.Repeat([]byte{7}, 32)
	starterCredential := base64.RawURLEncoding.EncodeToString(secret)
	hash := sha256.Sum256(secret)
	starter := Arrival{ArrivalHandle: utilities.IDFromBytes([16]byte{1}), GuestCredentialHash: hash[:]}
	space := PublicSpace{TenantID: utilities.IDFromBytes([16]byte{2}), SpaceID: utilities.IDFromBytes([16]byte{3})}
	started := starterLifecycle{lifecycle: AutoLifecycle{CreatorArrivalHandle: starter.ArrivalHandle}}
	for _, tc := range []struct {
		name      string
		lifecycle starterLifecycle
		input     PublicInviteArrivalInput
		want      string
	}{
		{"a browser with the starter cookie is the owner", started, PublicInviteArrivalInput{StarterCredentials: map[string]string{starter.ArrivalHandle.String(): starterCredential}}, PublicRoleOwner},
		{"a native client that keeps its guest credential is the owner", started, PublicInviteArrivalInput{GuestCredential: starterCredential}, PublicRoleOwner},
		{"a joiner with no starter credential is a collaborator", started, PublicInviteArrivalInput{}, PublicRoleCollaborator},
		{"a wrong starter credential is a collaborator", started, PublicInviteArrivalInput{StarterCredentials: map[string]string{starter.ArrivalHandle.String(): "someone-elses-credential"}}, PublicRoleCollaborator},
		{"a starter cookie of another call is ignored", started, PublicInviteArrivalInput{StarterCredentials: map[string]string{utilities.IDFromBytes([16]byte{9}).String(): starterCredential}}, PublicRoleCollaborator},
		{"a Space nobody started is joined as a collaborator", starterLifecycle{err: ErrAutoLifecycleNotFound}, PublicInviteArrivalInput{GuestCredential: starterCredential}, PublicRoleCollaborator},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runtime := Runtime{service: Service{repository: starterStore{starter: starter}, lifecycle: tc.lifecycle}}
			got, err := runtime.arrivalRole(context.Background(), space, tc.input)
			if err != nil || got != tc.want {
				t.Fatalf("role = %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}
