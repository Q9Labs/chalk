package publicinvites

import (
	"context"
	"crypto/ed25519"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type codeRepository struct {
	Repository
	invite        Invite
	arrival       Arrival
	createErrors  []error
	createHandles [][]byte
}

func (r *codeRepository) GetInviteByCode(_ context.Context, code string) (Invite, error) {
	if InviteCode(r.invite.Handle) != code {
		return Invite{}, ErrInviteNotFound
	}
	return r.invite, nil
}

func (r *codeRepository) GetInviteByHandle(_ context.Context, handle []byte) (Invite, error) {
	if string(handle) != string(r.invite.Handle) {
		return Invite{}, ErrInviteNotFound
	}
	return r.invite, nil
}

func (r *codeRepository) CreateOrGetInvite(_ context.Context, invite Invite) (Invite, error) {
	r.createHandles = append(r.createHandles, append([]byte(nil), invite.Handle...))
	if len(r.createErrors) > 0 {
		err := r.createErrors[0]
		r.createErrors = r.createErrors[1:]
		if err != nil {
			return Invite{}, err
		}
	}
	r.invite = invite
	return invite, nil
}

func (r *codeRepository) CreateArrival(_ context.Context, arrival Arrival) (Arrival, error) {
	r.arrival = arrival
	return arrival, nil
}

func (r *codeRepository) GetArrivalByIdempotency(context.Context, utilities.ID, utilities.ID, string) (Arrival, error) {
	return Arrival{}, ErrArrivalNotFound
}

func (r *codeRepository) GetArrival(context.Context, utilities.ID) (Arrival, error) {
	return r.arrival, nil
}

func (r *codeRepository) GetArrivalForCredential(context.Context, utilities.ID, []byte) (Arrival, error) {
	return r.arrival, nil
}

func (r *codeRepository) UpdateArrivalState(_ context.Context, input UpdateArrivalStateInput) (Arrival, error) {
	r.arrival.State = input.State
	r.arrival.EpisodeID = input.EpisodeID
	r.arrival.ParticipantID = input.ParticipantID
	r.arrival.ParticipantGeneration = input.ParticipantGeneration
	r.arrival.Provider = input.Provider
	r.arrival.ProviderSubject = input.ProviderSubject
	return r.arrival, nil
}

func TestResolveInviteTokenAcceptsCodesAndLegacyTokens(t *testing.T) {
	invite := testCodeInvite(t, 1)
	repository := &codeRepository{invite: invite}
	service := NewService(repository, testCodeSigner(t))
	code := FormatInviteCode(InviteCode(invite.Handle))

	resolved, token, err := service.ResolveInviteToken(context.Background(), code)
	if err != nil || resolved.SpaceID != invite.SpaceID || string(token.Handle) != string(invite.Handle) || token.Generation != invite.Generation || token.KeyID != "" {
		t.Fatalf("resolve code = %+v, %+v, %v", resolved, token, err)
	}

	legacy, err := service.IssueInviteToken(invite)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.ResolveInviteToken(context.Background(), legacy); err != nil {
		t.Fatalf("resolve legacy token: %v", err)
	}
}

func TestResolveInviteTokenHidesUnavailableCodes(t *testing.T) {
	invite := testCodeInvite(t, 2)
	repository := &codeRepository{invite: invite}
	service := NewService(repository, testCodeSigner(t))
	oldCode := FormatInviteCode(InviteCode(invite.Handle))

	for name, prepare := range map[string]func(){
		"unknown":  func() { repository.invite.Handle = make([]byte, HandleBytes) },
		"disabled": func() { repository.invite.Enabled = false },
		"rotated": func() {
			repository.invite.Enabled = true
			repository.invite.Handle = repeatedCodeBytes(9)
			repository.invite.Generation++
		},
	} {
		t.Run(name, func(t *testing.T) {
			repository.invite = invite
			prepare()
			if _, _, err := service.ResolveInviteToken(context.Background(), oldCode); !errors.Is(err, ErrInviteUnavailable) {
				t.Fatalf("ResolveInviteToken() error = %v", err)
			}
		})
	}
}

func TestEnsureInviteRetriesCodeCollisions(t *testing.T) {
	repository := &codeRepository{createErrors: []error{ErrInviteCodeTaken, ErrInviteCodeTaken, nil}}
	service := NewService(repository)
	tenantID, spaceID := testCodeID(t), testCodeID(t)
	if _, err := service.EnsureInvite(context.Background(), tenantID, spaceID, utilities.ID{}, AdmissionOpen); err != nil {
		t.Fatal(err)
	}
	if len(repository.createHandles) != 3 || string(repository.createHandles[0]) == string(repository.createHandles[1]) || string(repository.createHandles[1]) == string(repository.createHandles[2]) {
		t.Fatalf("generated handles = %x", repository.createHandles)
	}
}

func TestArriveAcceptsCodeAndOldCodeResumesItsArrival(t *testing.T) {
	invite := testCodeInvite(t, 3)
	repository := &codeRepository{invite: invite}
	service := NewService(repository, testCodeSigner(t))
	space := codeSpace{value: PublicSpace{TenantID: invite.TenantID, SpaceID: invite.SpaceID, Name: "Design Lab", Slug: "design-lab", AdmissionMode: AdmissionOpen}}
	runtime := Runtime{service: service, space: space, access: codeAccess{}}
	code := FormatInviteCode(InviteCode(invite.Handle))
	key := testCodeID(t).String()

	first, err := runtime.Arrive(context.Background(), PublicInviteArrivalInput{Token: code, DisplayName: "Ada", RequestKey: key})
	if err != nil || first.State != ArrivalAdmitted || first.GuestCredential == "" {
		t.Fatalf("fresh arrival = %+v, %v", first, err)
	}
	arrivalHandle := first.ArrivalHandle
	repository.invite.Handle = repeatedCodeBytes(4)
	repository.invite.Generation++

	resumed, err := runtime.Arrive(context.Background(), PublicInviteArrivalInput{Token: code, DisplayName: "Ada", ArrivalHandle: arrivalHandle, GuestCredential: first.GuestCredential})
	if err != nil || resumed.State != ArrivalAdmitted {
		t.Fatalf("resumed arrival = %+v, %v", resumed, err)
	}
}

type codeSpace struct {
	Space
	value PublicSpace
}

func (s codeSpace) GetPublicSpace(context.Context, utilities.ID, utilities.ID) (PublicSpace, error) {
	return s.value, nil
}

type codeAccess struct{ Access }

func (codeAccess) GrantPublicAccess(_ context.Context, input PublicAccessInput) (PublicAccessGrant, error) {
	id := input.Arrival.ArrivalHandle
	return PublicAccessGrant{
		TenantID: input.Arrival.TenantID, SpaceID: input.Arrival.SpaceID, EpisodeID: id,
		ParticipantID: id, ParticipantGeneration: 1, Provider: PublicProviderCloudflareSFU,
		ProviderSubject: "code-test", ClientPayload: PublicAccessClientPayload{ConnectionID: "code-test", StunServer: "stun.example.test"},
	}, nil
}

func testCodeInvite(t *testing.T, fill byte) Invite {
	t.Helper()
	return Invite{
		TenantID: testCodeID(t), SpaceID: testCodeID(t), Handle: repeatedCodeBytes(fill),
		Generation: 1, StateEpoch: 1, Enabled: true, PublicRole: PublicRoleCollaborator, AdmissionMode: AdmissionOpen,
	}
}

func testCodeID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func repeatedCodeBytes(fill byte) []byte {
	handle := make([]byte, HandleBytes)
	for i := range handle {
		handle[i] = fill
	}
	return handle
}

func testCodeSigner(t *testing.T) Signer {
	t.Helper()
	private := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	signer, err := NewSigner(Keyring{CurrentKeyID: "code-test", Signer: private, Verifiers: map[string]ed25519.PublicKey{"code-test": private.Public().(ed25519.PublicKey)}})
	if err != nil {
		t.Fatal(err)
	}
	return signer
}
