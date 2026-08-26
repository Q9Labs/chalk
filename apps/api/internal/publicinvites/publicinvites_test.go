package publicinvites

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestSignerVerifierRoundTripAndKeyRotation(t *testing.T) {
	oldPublic, oldPrivate, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	newPublic, newPrivate, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	oldSigner, err := NewSigner(Keyring{CurrentKeyID: "old", Signer: oldPrivate, Verifiers: map[string]ed25519.PublicKey{"old": oldPublic}})
	if err != nil {
		t.Fatal(err)
	}
	rotatedSigner, err := NewSigner(Keyring{
		CurrentKeyID: "new",
		Signer:       newPrivate,
		Verifiers: map[string]ed25519.PublicKey{
			"old": oldPublic,
			"new": newPublic,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	handle := bytesOf(0x21, HandleBytes)
	oldToken, err := oldSigner.Issue(handle, 7)
	if err != nil {
		t.Fatal(err)
	}
	oldRaw, err := oldSigner.Encode(oldToken)
	if err != nil {
		t.Fatal(err)
	}
	verified, err := rotatedSigner.Verify(oldRaw)
	if err != nil {
		t.Fatalf("verify rollover token: %v", err)
	}
	if verified.KeyID != "old" || verified.Generation != 7 || string(verified.Handle) != string(handle) {
		t.Fatalf("verified token = %#v", verified)
	}
	newToken, newRaw, err := rotatedSigner.IssueRandom(8)
	if err != nil {
		t.Fatal(err)
	}
	if newToken.KeyID != "new" {
		t.Fatalf("new token key id = %q", newToken.KeyID)
	}
	if _, err := oldSigner.Verify(newRaw); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("old verifier error = %v, want unknown key", err)
	}
}

func TestVerifierRejectsTokenSyntaxSignatureAudienceAndTrailingData(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := NewSigner(Keyring{CurrentKeyID: "primary", Signer: privateKey, Verifiers: map[string]ed25519.PublicKey{"primary": publicKey}})
	if err != nil {
		t.Fatal(err)
	}
	token, err := signer.Issue(bytesOf(0x44, HandleBytes), 3)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := signer.Encode(token)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name  string
		value string
		want  error
	}{
		{name: "segment count", value: raw + ".extra", want: ErrInvalidToken},
		{name: "version", value: strings.Replace(raw, TokenVersion, "cspi0", 1), want: ErrInvalidToken},
		{name: "unknown key", value: strings.Replace(raw, ".primary.", ".missing.", 1), want: ErrUnknownKey},
		{name: "signature", value: raw[:len(raw)-1] + flipLast(raw[len(raw)-1:]), want: ErrInvalidToken},
		{name: "payload encoding", value: strings.Join([]string{TokenVersion, "primary", "!", strings.Split(raw, ".")[3]}, "."), want: ErrInvalidToken},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, got := signer.Verify(test.value); !errors.Is(got, test.want) {
				t.Fatalf("error = %v, want %v", got, test.want)
			}
		})
	}

	segments := strings.Split(raw, ".")
	payloadBytes, err := base64.RawURLEncoding.DecodeString(segments[2])
	if err != nil {
		t.Fatal(err)
	}
	var decoded payload
	if err := json.Unmarshal(payloadBytes, &decoded); err != nil {
		t.Fatal(err)
	}
	decoded.Audience = "wrong-audience"
	segments[2] = base64.RawURLEncoding.EncodeToString(mustJSON(t, decoded))
	segments[3] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, []byte(strings.Join(segments[:3], "."))))
	if _, err := signer.Verify(strings.Join(segments, ".")); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("audience error = %v, want invalid payload", err)
	}

	decoded.Audience = TokenAudience
	trailingPayload := append(mustJSON(t, decoded), []byte(` {}`)...)
	segments[2] = base64.RawURLEncoding.EncodeToString(trailingPayload)
	segments[3] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, []byte(strings.Join(segments[:3], "."))))
	if _, err := signer.Verify(strings.Join(segments, ".")); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("trailing data error = %v, want invalid payload", err)
	}
}

func TestKeyringValidationAndCopy(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, keyring := range map[string]Keyring{
		"missing signer":           {CurrentKeyID: "primary", Verifiers: map[string]ed25519.PublicKey{"primary": publicKey}},
		"missing current verifier": {CurrentKeyID: "primary", Signer: privateKey, Verifiers: map[string]ed25519.PublicKey{"old": publicKey}},
		"mismatched signer":        {CurrentKeyID: "primary", Signer: ed25519.NewKeyFromSeed(bytesOf(0x11, ed25519.SeedSize)), Verifiers: map[string]ed25519.PublicKey{"primary": publicKey}},
		"invalid key id":           {CurrentKeyID: "primary.bad", Signer: privateKey, Verifiers: map[string]ed25519.PublicKey{"primary.bad": publicKey}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NewSigner(keyring); !errors.Is(err, ErrInvalidKeyring) && !errors.Is(err, ErrInvalidKeyID) {
				t.Fatalf("error = %v, want keyring/key id error", err)
			}
		})
	}
	verifiers := map[string]ed25519.PublicKey{"primary": append(ed25519.PublicKey(nil), publicKey...)}
	verifier, err := NewVerifier(verifiers)
	if err != nil {
		t.Fatal(err)
	}
	verifiers["primary"][0] ^= 0xff
	signer, err := NewSigner(Keyring{CurrentKeyID: "primary", Signer: privateKey, Verifiers: map[string]ed25519.PublicKey{"primary": publicKey}})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := signer.Encode(Token{KeyID: "primary", Handle: bytesOf(0x12, HandleBytes), Generation: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifier.Verify(raw); err != nil {
		t.Fatalf("copied verifier rejected token: %v", err)
	}
}

func TestEnsureInviteRotateAndEnablePreserveStateContracts(t *testing.T) {
	tenantID, spaceID, actorID := testIDs(t)
	repository := &fakeRepository{}
	service := NewService(repository)
	invite, err := service.EnsureInvite(context.Background(), tenantID, spaceID, actorID, AdmissionKnock)
	if err != nil {
		t.Fatal(err)
	}
	if len(repository.invite.Handle) != HandleBytes || repository.invite.Generation != 1 || repository.invite.StateEpoch != 1 || !repository.invite.Enabled {
		t.Fatalf("created invite = %#v", repository.invite)
	}
	if invite.SpaceID != spaceID || invite.AdmissionMode != AdmissionKnock {
		t.Fatalf("returned invite = %#v", invite)
	}
	repository.enabledResult = Invite{TenantID: tenantID, SpaceID: spaceID, Handle: bytesOf(0x33, HandleBytes), Generation: 1, StateEpoch: 2, Enabled: false, PublicRole: PublicRoleCollaborator, AdmissionMode: AdmissionKnock}
	updated, err := service.SetInviteEnabled(context.Background(), tenantID, spaceID, false, actorID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.StateEpoch != 2 || updated.Enabled || repository.enabled != false {
		t.Fatalf("disabled invite = %#v, enabled call = %v", updated, repository.enabled)
	}
	repository.rotateResult = Invite{TenantID: tenantID, SpaceID: spaceID, Handle: bytesOf(0x55, HandleBytes), Generation: 2, StateEpoch: 3, Enabled: true, PublicRole: PublicRoleCollaborator, AdmissionMode: AdmissionKnock}
	rotated, err := service.RotateInvite(context.Background(), tenantID, spaceID, actorID, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(repository.rotatedHandle) != HandleBytes || rotated.Generation != 2 || rotated.StateEpoch != 3 || !rotated.Enabled {
		t.Fatalf("rotated invite = %#v", rotated)
	}
}

func TestResolveInviteRejectsDisabledOrStaleGeneration(t *testing.T) {
	tenantID, spaceID, _ := testIDs(t)
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := NewSigner(Keyring{CurrentKeyID: "primary", Signer: privateKey, Verifiers: map[string]ed25519.PublicKey{"primary": publicKey}})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(&fakeRepository{}, signer)
	invite := Invite{TenantID: tenantID, SpaceID: spaceID, Handle: bytesOf(0x24, HandleBytes), Generation: 2, StateEpoch: 4, Enabled: false, PublicRole: PublicRoleCollaborator, AdmissionMode: AdmissionOpen}
	service.repository.(*fakeRepository).inviteByHandle = invite
	raw, err := service.IssueInviteToken(invite)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.ResolveInviteToken(context.Background(), raw); !errors.Is(err, ErrInviteUnavailable) {
		t.Fatalf("disabled invite error = %v", err)
	}
	invite.Enabled = true
	invite.Generation = 3
	service.repository.(*fakeRepository).inviteByHandle = invite
	if _, _, err := service.ResolveInviteToken(context.Background(), raw); !errors.Is(err, ErrInviteUnavailable) {
		t.Fatalf("stale generation error = %v", err)
	}
}

func TestCreateArrivalHashesGuestCredentialAndHandlesIdempotency(t *testing.T) {
	tenantID, spaceID, _ := testIDs(t)
	repository := &fakeRepository{arrivalNotFound: true}
	service := NewService(repository).WithClock(func() time.Time { return time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC) })
	credential := []byte("guest-credential-123456")
	input := CreateArrivalInput{
		TenantID:         tenantID,
		SpaceID:          spaceID,
		Invite:           Token{Handle: bytesOf(0x31, HandleBytes), Generation: 1},
		InviteStateEpoch: 1,
		IdentityMode:     IdentityGuest,
		DisplayName:      "Guest",
		GuestCredential:  credential,
		IdempotencyKey:   "arrival-request-0001",
	}
	created, err := service.CreateArrival(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	wantHash := sha256.Sum256(credential)
	if string(repository.arrival.GuestCredentialHash) != string(wantHash[:]) || string(created.Credential) != string(credential) {
		t.Fatalf("arrival credential hash/return = %x/%q", repository.arrival.GuestCredentialHash, created.Credential)
	}
	if repository.arrival.IdempotencyFingerprint == [32]byte{} {
		t.Fatal("arrival fingerprint is zero")
	}
	repository.arrivalNotFound = false
	replayed, err := service.CreateArrival(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.Arrival.ArrivalHandle != created.Arrival.ArrivalHandle || len(replayed.Credential) != 0 {
		t.Fatalf("replayed result = %#v", replayed)
	}
	repository.arrival.IdempotencyFingerprint = [32]byte{0x99}
	if _, err := service.CreateArrival(context.Background(), input); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflict error = %v", err)
	}
}

func TestCreateArrivalValidatesIdentityAndExpiry(t *testing.T) {
	tenantID, spaceID, accountID := testIDs(t)
	service := NewService(&fakeRepository{arrivalNotFound: true}).WithClock(func() time.Time { return time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC) })
	base := CreateArrivalInput{TenantID: tenantID, SpaceID: spaceID, Invite: Token{Handle: bytesOf(0x31, HandleBytes), Generation: 1}, InviteStateEpoch: 1, DisplayName: "Guest", IdempotencyKey: "arrival-request-0001"}
	for name, input := range map[string]CreateArrivalInput{
		"account missing id":  {TenantID: tenantID, SpaceID: spaceID, Invite: base.Invite, InviteStateEpoch: 1, IdentityMode: IdentityAccount, DisplayName: base.DisplayName, IdempotencyKey: base.IdempotencyKey},
		"guest account mix":   {TenantID: tenantID, SpaceID: spaceID, Invite: base.Invite, InviteStateEpoch: 1, IdentityMode: IdentityGuest, DisplayName: base.DisplayName, AccountID: accountID, GuestCredential: []byte("guest-credential-123456"), IdempotencyKey: base.IdempotencyKey},
		"state epoch missing": {TenantID: tenantID, SpaceID: spaceID, Invite: base.Invite, IdentityMode: IdentityGuest, DisplayName: base.DisplayName, GuestCredential: []byte("guest-credential-123456"), IdempotencyKey: base.IdempotencyKey},
		"expiry in past":      {TenantID: tenantID, SpaceID: spaceID, Invite: base.Invite, InviteStateEpoch: 1, IdentityMode: IdentityGuest, DisplayName: base.DisplayName, GuestCredential: []byte("guest-credential-123456"), IdempotencyKey: base.IdempotencyKey, ExpiresAt: time.Date(2026, 8, 19, 11, 59, 59, 0, time.UTC)},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := service.CreateArrival(context.Background(), input); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestAdmissionDecisionAndLifecycleValidation(t *testing.T) {
	tenantID, spaceID, _ := testIDs(t)
	lifecycle := &fakeLifecycle{}
	service, err := NewServiceWithLifecycle(&fakeRepository{}, lifecycle)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	service = service.WithClock(func() time.Time { return now })
	if _, err := service.CreateAdmissionRequest(context.Background(), CreateAdmissionRequestInput{DisplayName: "Ada"}); !errors.Is(err, ErrInvalidAdmissionRequest) {
		t.Fatalf("missing arrival error = %v", err)
	}
	request, err := service.CreateAdmissionRequest(context.Background(), CreateAdmissionRequestInput{ArrivalHandle: mustID(t, "44444444-4444-4444-8444-444444444444"), DisplayName: " Ada ", ExpiresAt: now.Add(time.Minute)})
	if err != nil || request.DisplayName != "Ada" || request.State != AdmissionRequestPending {
		t.Fatalf("request = %#v, error = %v", request, err)
	}
	if _, _, err := service.DecideAdmissionRequest(context.Background(), DecideAdmissionRequestInput{TenantID: tenantID, SpaceID: spaceID, RequestHandle: request.RequestHandle, Decision: "maybe"}); !errors.Is(err, ErrInvalidAdmissionDecision) {
		t.Fatalf("invalid decision error = %v", err)
	}
	lifecycleInput := AutoLifecycle{TenantID: tenantID, SpaceID: spaceID, DeadlineAt: now.Add(time.Hour), State: AutoLifecycleArchived}
	if _, err := service.CreateAutoLifecycle(context.Background(), lifecycleInput); !errors.Is(err, ErrInvalidLifecycleState) {
		t.Fatalf("archived create error = %v", err)
	}
	created, err := service.CreateAutoLifecycle(context.Background(), AutoLifecycle{TenantID: tenantID, SpaceID: spaceID, DeadlineAt: now.Add(time.Hour)})
	if err != nil || created.State != AutoLifecycleActive || lifecycle.created.State != AutoLifecycleActive {
		t.Fatalf("created lifecycle = %#v, stored = %#v, error = %v", created, lifecycle.created, err)
	}
	if _, err := service.RetryAutoLifecycle(context.Background(), RetryAutoLifecycleInput{TenantID: tenantID, SpaceID: spaceID, NextRetryAt: now.Add(time.Minute), ErrorFamily: strings.Repeat("x", MaxLifecycleErrorFamilySize+1)}); !errors.Is(err, ErrInvalidLifecycleState) {
		t.Fatalf("long retry family error = %v", err)
	}
	if _, err := service.RetryAutoLifecycle(context.Background(), RetryAutoLifecycleInput{TenantID: tenantID, SpaceID: spaceID, NextRetryAt: now.Add(time.Minute), ErrorFamily: "provider_timeout"}); err != nil {
		t.Fatalf("retry lifecycle: %v", err)
	}
	if lifecycle.retry.ErrorFamily != "provider_timeout" {
		t.Fatalf("retry input = %#v", lifecycle.retry)
	}
}

func TestRuntimeCreatePublicSpaceGrantsCreatorAndUsesOneHourLifecycle(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	result, err := fixture.runtime.CreatePublicSpace(context.Background(), CreatePublicSpaceInput{
		DisplayName: "Demo Space",
		RequestKey:  "create-public-space-0001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if fixture.access.grantCalls != 1 {
		t.Fatalf("grant calls = %d, want 1", fixture.access.grantCalls)
	}
	if fixture.repo.arrival.State != ArrivalAdmitted || fixture.repo.arrival.EpisodeID != fixture.access.grant.EpisodeID || fixture.repo.arrival.ParticipantID != fixture.access.grant.ParticipantID {
		t.Fatalf("creator arrival = %#v", fixture.repo.arrival)
	}
	if fixture.repo.arrival.Provider != fixture.access.grant.Provider || fixture.repo.arrival.ProviderSubject != fixture.access.grant.ProviderSubject {
		t.Fatalf("creator provider binding = %q/%q", fixture.repo.arrival.Provider, fixture.repo.arrival.ProviderSubject)
	}
	if !fixture.lifecycle.created.DeadlineAt.Equal(fixture.now.Add(time.Hour)) {
		t.Fatalf("deadline = %s, want %s", fixture.lifecycle.created.DeadlineAt, fixture.now.Add(time.Hour))
	}
	if fixture.lifecycle.created.CreatorArrivalHandle != fixture.repo.arrival.ArrivalHandle {
		t.Fatalf("creator arrival handle = %s, want %s", fixture.lifecycle.created.CreatorArrivalHandle, fixture.repo.arrival.ArrivalHandle)
	}
	wantInviteLink := "https://invite.test/space/" + fixture.links.slug + "#spaceInviteToken=" + fixture.links.token
	if result.InviteLink != wantInviteLink {
		t.Fatalf("invite link = %q, want %q", result.InviteLink, wantInviteLink)
	}
	if result.Arrival.State != ArrivalAdmitted || result.Arrival.Access == nil || result.GuestCredential == "" || result.Arrival.Access.ClientPayload != fixture.access.grant.ClientPayload {
		t.Fatalf("create result = %#v", result)
	}
}

func TestRuntimeCreatePublicSpaceUsesConfiguredLifecycle(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	fixture.runtime.autoLifecycleLifetime = 15 * time.Minute

	result, err := fixture.runtime.CreatePublicSpace(context.Background(), CreatePublicSpaceInput{
		DisplayName: "Configured lifetime",
		RequestKey:  "configured-lifetime-0001",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := fixture.now.Add(15 * time.Minute)
	if !result.LifecycleUntil.Equal(want) || !fixture.lifecycle.created.DeadlineAt.Equal(want) {
		t.Fatalf("lifecycle deadline = %s/%s, want %s", result.LifecycleUntil, fixture.lifecycle.created.DeadlineAt, want)
	}
}

func TestNewRuntimeWithConfigRejectsInvalidLifecycle(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	_, err := NewRuntimeWithConfig(fixture.runtime.service, fixture.space, fixture.lifecycle, fixture.access, fixture.accounts, fixture.links, RuntimeConfig{
		AutoLifecycleLifetime: time.Hour + time.Second,
	})
	if !errors.Is(err, ErrInvalidLifecycleState) {
		t.Fatalf("NewRuntimeWithConfig error = %v, want %v", err, ErrInvalidLifecycleState)
	}
}

func TestRuntimeCreatePublicSpacePropagatesInviteLinkError(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	wantErr := errors.New("link unavailable")
	fixture.links.err = wantErr

	_, err := fixture.runtime.CreatePublicSpace(context.Background(), CreatePublicSpaceInput{
		DisplayName: "Demo Space",
		RequestKey:  "create-public-space-0001",
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("create error = %v, want %v", err, wantErr)
	}
	if !fixture.repo.arrival.ArrivalHandle.IsZero() {
		t.Fatalf("arrival created after link failure: %s", fixture.repo.arrival.ArrivalHandle)
	}
}

func TestRuntimeCreatePublicSpaceReplayRefreshesWithoutReplacingGuestCredential(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	input := CreatePublicSpaceInput{DisplayName: "Demo Space", RequestKey: "create-public-space-0001"}
	first, err := fixture.runtime.CreatePublicSpace(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := fixture.runtime.CreatePublicSpace(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if first.GuestCredential == "" || second.GuestCredential != first.GuestCredential {
		t.Fatalf("replay credentials first=%q second=%q", first.GuestCredential, second.GuestCredential)
	}
	if fixture.access.grantCalls != 1 || fixture.access.refreshCalls != 1 {
		t.Fatalf("access calls grant=%d refresh=%d", fixture.access.grantCalls, fixture.access.refreshCalls)
	}
	if second.Arrival.ArrivalHandle != first.Arrival.ArrivalHandle || second.InviteLink != first.InviteLink || !second.LifecycleUntil.Equal(first.LifecycleUntil) {
		t.Fatalf("replay response changed: first=%#v second=%#v", first, second)
	}
}

func TestRuntimeCreatePublicSpaceRequiresRequestKey(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	_, err := fixture.runtime.CreatePublicSpace(context.Background(), CreatePublicSpaceInput{DisplayName: "Demo Space"})
	if !errors.Is(err, ErrInvalidRequestKey) {
		t.Fatalf("create error = %v, want %v", err, ErrInvalidRequestKey)
	}
	if !fixture.repo.arrival.ArrivalHandle.IsZero() {
		t.Fatalf("arrival created without request key: %s", fixture.repo.arrival.ArrivalHandle)
	}
}

func TestRuntimeOpenArrivalReplayRefreshesExistingGrant(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	first, err := fixture.runtime.Arrive(context.Background(), PublicInviteArrivalInput{
		Token:       fixture.token,
		DisplayName: "Guest",
		RequestKey:  "open-arrival-request-01",
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.State != ArrivalAdmitted || first.GuestCredential == "" {
		t.Fatalf("first arrival = %#v", first)
	}
	second, err := fixture.runtime.Arrive(context.Background(), PublicInviteArrivalInput{
		Token:           fixture.token,
		ArrivalHandle:   first.ArrivalHandle,
		GuestCredential: first.GuestCredential,
	})
	if err != nil {
		t.Fatal(err)
	}
	if fixture.access.grantCalls != 1 || fixture.access.refreshCalls != 1 {
		t.Fatalf("grant/refresh calls = %d/%d, want 1/1", fixture.access.grantCalls, fixture.access.refreshCalls)
	}
	if second.Access == nil || second.State != ArrivalAdmitted || second.GuestCredential != "" || second.Access.ClientPayload != fixture.access.grant.ClientPayload {
		t.Fatalf("replay result = %#v", second)
	}
}

func TestRuntimeGuestArrivalRetryWithoutFirstResponsePreservesAuthenticability(t *testing.T) {
	for _, native := range []bool{false, true} {
		t.Run(map[bool]string{false: "browser", true: "native"}[native], func(t *testing.T) {
			fixture := newRuntimeFixture(t, AdmissionOpen)
			requestKey := "lost-response-arrival-01"
			first, err := fixture.runtime.Arrive(context.Background(), PublicInviteArrivalInput{
				Token:       fixture.token,
				DisplayName: "Guest",
				RequestKey:  requestKey,
				Native:      native,
			})
			if err != nil {
				t.Fatal(err)
			}
			if first.GuestCredential == "" {
				t.Fatal("first arrival did not return a guest credential")
			}

			// The first response is lost, so the retry has neither the arrival
			// handle nor the credential that a successful response would carry.
			retried, err := fixture.runtime.Arrive(context.Background(), PublicInviteArrivalInput{
				Token:       fixture.token,
				DisplayName: "Guest",
				RequestKey:  requestKey,
				Native:      native,
			})
			if err != nil {
				t.Fatal(err)
			}
			if retried.ArrivalHandle != first.ArrivalHandle || retried.GuestCredential != first.GuestCredential {
				t.Fatalf("retry arrival = %#v, first = %#v", retried, first)
			}
			if _, err := fixture.runtime.ArrivalStatus(context.Background(), PublicInviteArrivalStatusInput{
				ArrivalHandle:   retried.ArrivalHandle,
				GuestCredential: retried.GuestCredential,
				Native:          native,
			}); err != nil {
				t.Fatalf("authenticate recovered arrival: %v", err)
			}
		})
	}
}

func TestRuntimePreservesTypedSFUClientPayload(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	fixture.access.grant.Provider = PublicProviderCloudflareSFU
	fixture.access.grant.ClientPayload = PublicAccessClientPayload{
		ConnectionID: "connection-id",
		StunServer:   "stun.example.test:3478",
	}
	result, err := fixture.runtime.Arrive(context.Background(), PublicInviteArrivalInput{
		Token:       fixture.token,
		DisplayName: "Guest",
		RequestKey:  "sfu-arrival-request-01",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Access == nil || result.Access.Provider != PublicProviderCloudflareSFU || result.Access.ClientPayload != fixture.access.grant.ClientPayload {
		t.Fatalf("SFU grant = %#v", result.Access)
	}
}

func TestRuntimeRejectsIncompleteTypedClientPayload(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	fixture.access.grant.ClientPayload.Token = ""
	if _, err := fixture.runtime.Arrive(context.Background(), PublicInviteArrivalInput{
		Token:       fixture.token,
		DisplayName: "Guest",
		RequestKey:  "invalid-payload-arrival-01",
	}); !errors.Is(err, ErrInvalidArrival) {
		t.Fatalf("incomplete client payload error = %v", err)
	}
}

func TestRuntimeAccountAuthorizationSelectsIdentity(t *testing.T) {
	authorized := newRuntimeFixture(t, AdmissionOpen)
	authorized.accounts.authorized = true
	accountArrival, err := authorized.runtime.Arrive(context.Background(), PublicInviteArrivalInput{
		Token:             authorized.token,
		DisplayName:       "Account",
		RequestKey:        "authorized-account-01",
		AccountID:         authorized.accountID,
		AccountAuthorized: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if authorized.accounts.calls != 1 || authorized.repo.arrival.IdentityMode != IdentityAccount || authorized.repo.arrival.AccountID != authorized.accountID || accountArrival.GuestCredential != "" {
		t.Fatalf("authorized account arrival = %#v, calls = %d", authorized.repo.arrival, authorized.accounts.calls)
	}
	if authorized.accounts.tenantID != authorized.tenantID {
		t.Fatalf("account authorization tenant = %s, want %s", authorized.accounts.tenantID, authorized.tenantID)
	}

	guest := newRuntimeFixture(t, AdmissionOpen)
	guest.accounts.authorized = false
	guestArrival, err := guest.runtime.Arrive(context.Background(), PublicInviteArrivalInput{
		Token:             guest.token,
		DisplayName:       "Guest",
		RequestKey:        "unauthorized-account-01",
		AccountID:         guest.accountID,
		AccountAuthorized: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if guest.accounts.calls != 1 || guest.repo.arrival.IdentityMode != IdentityGuest || !guest.repo.arrival.AccountID.IsZero() || guestArrival.GuestCredential == "" {
		t.Fatalf("unauthorized account fallback = %#v, result = %#v", guest.repo.arrival, guestArrival)
	}
}

func TestRuntimeKnockApprovalPersistsGrantAndDenialStaysTerminal(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionKnock)
	arrival := Arrival{
		ArrivalHandle:       mustID(t, "66666666-6666-4666-8666-666666666666"),
		TenantID:            fixture.tenantID,
		SpaceID:             fixture.spaceID,
		IdentityMode:        IdentityGuest,
		GuestCredentialHash: bytesOf(0x61, sha256.Size),
		State:               ArrivalPending,
	}
	requestHandle := mustID(t, "77777777-7777-4777-8777-777777777777")
	fixture.repo.arrival = arrival
	fixture.repo.arrivalNotFound = false
	fixture.repo.decisionRequest = AdmissionRequest{RequestHandle: requestHandle}
	approved, err := fixture.runtime.ApproveAdmissionRequest(context.Background(), DecidePublicAdmissionRequestInput{
		TenantID:      fixture.tenantID,
		SpaceID:       fixture.spaceID,
		RequestHandle: requestHandle.String(),
		RequestKey:    "approve-admission-01",
	})
	if err != nil {
		t.Fatal(err)
	}
	if approved.State != AdmissionRequestApproved || fixture.access.grantCalls != 1 || fixture.repo.arrival.State != ArrivalAdmitted {
		t.Fatalf("approved request = %#v, arrival = %#v, grants = %d", approved, fixture.repo.arrival, fixture.access.grantCalls)
	}
	if fixture.repo.arrival.EpisodeID != fixture.access.grant.EpisodeID || fixture.repo.arrival.ParticipantID != fixture.access.grant.ParticipantID || fixture.repo.arrival.Provider != fixture.access.grant.Provider || fixture.repo.arrival.ProviderSubject != fixture.access.grant.ProviderSubject {
		t.Fatalf("approved access binding = %#v", fixture.repo.arrival)
	}

	denialArrival := arrival
	denialArrival.ArrivalHandle = mustID(t, "88888888-8888-4888-8888-888888888888")
	denialRequestHandle := mustID(t, "99999999-9999-4999-8999-999999999999")
	fixture.repo.arrival = denialArrival
	fixture.repo.decisionArrival = Arrival{}
	fixture.repo.decisionRequest = AdmissionRequest{RequestHandle: denialRequestHandle}
	denied, err := fixture.runtime.DenyAdmissionRequest(context.Background(), DecidePublicAdmissionRequestInput{
		TenantID:      fixture.tenantID,
		SpaceID:       fixture.spaceID,
		RequestHandle: denialRequestHandle.String(),
		RequestKey:    "deny-admission-0001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if denied.State != AdmissionRequestDenied || fixture.access.grantCalls != 1 || fixture.repo.arrival.State != ArrivalRejected {
		t.Fatalf("denied request = %#v, arrival = %#v, grants = %d", denied, fixture.repo.arrival, fixture.access.grantCalls)
	}
}

func TestRuntimeRefreshAndLeaveUsePersistedProviderBinding(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	fixture.accounts.authorized = true
	fixture.repo.arrival = Arrival{
		ArrivalHandle:         mustID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
		TenantID:              fixture.tenantID,
		SpaceID:               fixture.spaceID,
		IdentityMode:          IdentityAccount,
		AccountID:             fixture.accountID,
		State:                 ArrivalAdmitted,
		EpisodeID:             fixture.access.grant.EpisodeID,
		ParticipantID:         fixture.access.grant.ParticipantID,
		ParticipantGeneration: fixture.access.grant.ParticipantGeneration,
		Provider:              fixture.access.grant.Provider,
		ProviderSubject:       fixture.access.grant.ProviderSubject,
	}
	fixture.repo.arrivalNotFound = false
	refreshed, err := fixture.runtime.RefreshAccess(context.Background(), PublicInviteRefreshInput{
		ArrivalHandle: fixture.repo.arrival.ArrivalHandle.String(),
		AccountID:     fixture.accountID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if fixture.access.refreshCalls != 1 || refreshed.ClientPayload != fixture.access.grant.ClientPayload || fixture.access.lastInput.Arrival.Provider != fixture.access.grant.Provider || fixture.access.lastInput.Arrival.ProviderSubject != fixture.access.grant.ProviderSubject {
		t.Fatalf("refresh input = %#v, calls = %d", fixture.access.lastInput.Arrival, fixture.access.refreshCalls)
	}
	if err := fixture.runtime.Leave(context.Background(), PublicInviteLeaveInput{
		ArrivalHandle: fixture.repo.arrival.ArrivalHandle.String(),
		AccountID:     fixture.accountID,
	}); err != nil {
		t.Fatal(err)
	}
	if fixture.access.revokeCalls != 1 || fixture.repo.arrival.State != ArrivalLeft || fixture.repo.arrival.Provider != fixture.access.grant.Provider || fixture.repo.arrival.ProviderSubject != fixture.access.grant.ProviderSubject {
		t.Fatalf("left arrival = %#v, revoke calls = %d", fixture.repo.arrival, fixture.access.revokeCalls)
	}
}

func TestRuntimeRefreshReplacementPersistsNewProviderSubject(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	fixture.accounts.authorized = true
	oldSubject := "old-participant-subject"
	newGrant := fixture.access.grant
	newGrant.ProviderSubject = "new-participant-subject"
	newGrant.ClientPayload.ProviderSubject = newGrant.ProviderSubject
	fixture.access.refresh = newGrant
	fixture.repo.arrival = Arrival{
		ArrivalHandle:         mustID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
		TenantID:              fixture.tenantID,
		SpaceID:               fixture.spaceID,
		IdentityMode:          IdentityAccount,
		AccountID:             fixture.accountID,
		State:                 ArrivalAdmitted,
		EpisodeID:             fixture.access.grant.EpisodeID,
		ParticipantID:         fixture.access.grant.ParticipantID,
		ParticipantGeneration: fixture.access.grant.ParticipantGeneration,
		Provider:              fixture.access.grant.Provider,
		ProviderSubject:       oldSubject,
	}
	fixture.repo.arrivalNotFound = false

	refreshed, err := fixture.runtime.RefreshAccess(context.Background(), PublicInviteRefreshInput{
		ArrivalHandle:          fixture.repo.arrival.ArrivalHandle.String(),
		AccountID:              fixture.accountID,
		ReplaceMediaConnection: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.ProviderSubject != newGrant.ProviderSubject || fixture.repo.arrival.ProviderSubject != newGrant.ProviderSubject {
		t.Fatalf("provider subject = grant %q, persisted %q, want %q", refreshed.ProviderSubject, fixture.repo.arrival.ProviderSubject, newGrant.ProviderSubject)
	}
	if fixture.repo.arrival.ParticipantID != newGrant.ParticipantID || fixture.repo.arrival.ParticipantGeneration != newGrant.ParticipantGeneration {
		t.Fatalf("participant identity changed: %#v", fixture.repo.arrival)
	}
	if !fixture.access.lastInput.ReplaceMediaConnection {
		t.Fatal("replacement flag was not passed to access port")
	}
}

func TestRuntimeManagedInviteReturnsCurrentCanonicalURL(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	managed, err := fixture.runtime.GetInvite(context.Background(), fixture.tenantID, fixture.spaceID)
	if err != nil {
		t.Fatal(err)
	}
	if managed.Invite.Handle == nil || !strings.HasPrefix(managed.CanonicalURL, "https://invite.test/space/demo-space#spaceInviteToken=cspi1.") {
		t.Fatalf("managed invite = %#v", managed)
	}
	fixture.repo.enabledResult = fixture.invite
	if updated, err := fixture.runtime.UpdateInvite(context.Background(), UpdateSpacePublicInviteInput{TenantID: fixture.tenantID, SpaceID: fixture.spaceID, Enabled: true}); err != nil || updated.CanonicalURL == "" {
		t.Fatalf("updated managed invite = %#v, err = %v", updated, err)
	}
	fixture.repo.rotateResult = fixture.invite
	if rotated, err := fixture.runtime.RotateInvite(context.Background(), RotateSpacePublicInviteInput{TenantID: fixture.tenantID, SpaceID: fixture.spaceID, RequestKey: "rotate-invite-0001"}); err != nil || rotated.CanonicalURL == "" {
		t.Fatalf("rotated managed invite = %#v, err = %v", rotated, err)
	}
}

func TestRuntimeGetInviteLazilyMaterializesMissingInvite(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	fixture.repo.getInviteErr = ErrInviteNotFound
	managed, err := fixture.runtime.GetInvite(context.Background(), fixture.tenantID, fixture.spaceID)
	if err != nil {
		t.Fatal(err)
	}
	if managed.Generation != 1 || managed.StateEpoch != 1 || !managed.Enabled || managed.AdmissionMode != AdmissionOpen {
		t.Fatalf("materialized invite = %#v", managed.Invite)
	}
	if fixture.repo.invite.Generation != 1 || fixture.repo.invite.StateEpoch != 1 {
		t.Fatalf("persisted invite = %#v", fixture.repo.invite)
	}
}

func TestRuntimeUpdateInviteLazilyMaterializesMissingInvite(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	fixture.repo.enabledErr = ErrInviteNotFound
	fixture.repo.enabledResult = fixture.invite

	managed, err := fixture.runtime.UpdateInvite(context.Background(), UpdateSpacePublicInviteInput{
		TenantID: fixture.tenantID,
		SpaceID:  fixture.spaceID,
		Enabled:  false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if managed.Generation != fixture.invite.Generation || !bytes.Equal(managed.Handle, fixture.invite.Handle) || fixture.repo.enabledCalls != 2 || fixture.repo.ensureCalls != 1 || fixture.repo.enabled {
		t.Fatalf("updated invite = %#v, enabled calls = %d, ensure calls = %d, enabled = %v", managed.Invite, fixture.repo.enabledCalls, fixture.repo.ensureCalls, fixture.repo.enabled)
	}
}

func TestRuntimeRotateInviteLazilyMaterializesMissingInvite(t *testing.T) {
	fixture := newRuntimeFixture(t, AdmissionOpen)
	fixture.repo.rotateErr = ErrInviteNotFound
	fixture.repo.rotateResult = fixture.invite

	managed, err := fixture.runtime.RotateInvite(context.Background(), RotateSpacePublicInviteInput{
		TenantID:   fixture.tenantID,
		SpaceID:    fixture.spaceID,
		RequestKey: "rotate-missing-invite-01",
	})
	if err != nil {
		t.Fatal(err)
	}
	if managed.Generation != fixture.invite.Generation || !bytes.Equal(managed.Handle, fixture.invite.Handle) || fixture.repo.rotateCalls != 2 || fixture.repo.ensureCalls != 1 {
		t.Fatalf("rotated invite = %#v, rotate calls = %d, ensure calls = %d", managed.Invite, fixture.repo.rotateCalls, fixture.repo.ensureCalls)
	}
}

func TestRuntimeInviteMutationRejectsMismatchedSpaceBeforeEnsure(t *testing.T) {
	for _, rotate := range []bool{false, true} {
		t.Run(map[bool]string{false: "update", true: "rotate"}[rotate], func(t *testing.T) {
			fixture := newRuntimeFixture(t, AdmissionOpen)
			fixture.space.space.SpaceID = mustID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
			if rotate {
				fixture.repo.rotateErr = ErrInviteNotFound
				_, err := fixture.runtime.RotateInvite(context.Background(), RotateSpacePublicInviteInput{TenantID: fixture.tenantID, SpaceID: fixture.spaceID, RequestKey: "rotate-mismatch-01"})
				if !errors.Is(err, ErrInviteUnavailable) {
					t.Fatalf("rotate error = %v, want invite unavailable", err)
				}
				if fixture.repo.rotateCalls != 1 {
					t.Fatalf("rotate calls = %d, want 1", fixture.repo.rotateCalls)
				}
			} else {
				fixture.repo.enabledErr = ErrInviteNotFound
				_, err := fixture.runtime.UpdateInvite(context.Background(), UpdateSpacePublicInviteInput{TenantID: fixture.tenantID, SpaceID: fixture.spaceID})
				if !errors.Is(err, ErrInviteUnavailable) {
					t.Fatalf("update error = %v, want invite unavailable", err)
				}
				if fixture.repo.enabledCalls != 1 {
					t.Fatalf("enabled calls = %d, want 1", fixture.repo.enabledCalls)
				}
			}
			if fixture.repo.ensureCalls != 0 {
				t.Fatalf("ensure calls = %d, want 0", fixture.repo.ensureCalls)
			}
		})
	}
}

type runtimeFixture struct {
	runtime   Runtime
	repo      *fakeRepository
	space     *fakeSpace
	access    *fakeAccess
	lifecycle *fakeLifecycle
	accounts  *fakeAccounts
	links     *fakeLinks
	tenantID  utilities.ID
	spaceID   utilities.ID
	accountID utilities.ID
	invite    Invite
	token     string
	now       time.Time
}

func newRuntimeFixture(t *testing.T, mode AdmissionMode) runtimeFixture {
	t.Helper()
	tenantID, spaceID, accountID := testIDs(t)
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := NewSigner(Keyring{CurrentKeyID: "primary", Signer: privateKey, Verifiers: map[string]ed25519.PublicKey{"primary": publicKey}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	invite := Invite{
		TenantID:      tenantID,
		SpaceID:       spaceID,
		Handle:        bytesOf(0x71, HandleBytes),
		Generation:    1,
		StateEpoch:    1,
		Enabled:       true,
		PublicRole:    PublicRoleCollaborator,
		AdmissionMode: mode,
	}
	repository := &fakeRepository{invite: invite, inviteByHandle: invite, arrivalNotFound: true}
	space := &fakeSpace{space: PublicSpace{TenantID: tenantID, SpaceID: spaceID, Name: "Demo Space", Slug: "demo-space", AdmissionMode: mode}}
	access := &fakeAccess{grant: PublicAccessGrant{
		TenantID:              tenantID,
		SpaceID:               spaceID,
		EpisodeID:             mustID(t, "44444444-4444-4444-8444-444444444444"),
		ParticipantID:         mustID(t, "55555555-5555-4555-8555-555555555555"),
		ParticipantGeneration: 2,
		Provider:              PublicProviderCloudflareRTK,
		ProviderSubject:       "participant-subject",
		ClientPayload: PublicAccessClientPayload{
			ProviderSubject: "participant-subject",
			Token:           "client-token",
		},
	}}
	lifecycle := &fakeLifecycle{}
	accounts := &fakeAccounts{}
	links := &fakeLinks{}
	service := NewService(repository, signer).WithClock(func() time.Time { return now })
	runtime, err := NewRuntime(service, space, lifecycle, access, accounts, links)
	if err != nil {
		t.Fatal(err)
	}
	token, err := service.IssueInviteToken(invite)
	if err != nil {
		t.Fatal(err)
	}
	return runtimeFixture{runtime: runtime, repo: repository, space: space, access: access, lifecycle: lifecycle, accounts: accounts, links: links, tenantID: tenantID, spaceID: spaceID, accountID: accountID, invite: invite, token: token, now: now}
}

type fakeRepository struct {
	invite          Invite
	getInviteErr    error
	inviteByHandle  Invite
	enabledResult   Invite
	enabledErr      error
	rotateResult    Invite
	rotateErr       error
	enabled         bool
	enabledCalls    int
	rotatedHandle   []byte
	rotateCalls     int
	ensureCalls     int
	arrival         Arrival
	arrivalNotFound bool
	decisionRequest AdmissionRequest
	decisionArrival Arrival
	decisionErr     error
}

func (r *fakeRepository) CreateOrGetInvite(_ context.Context, invite Invite) (Invite, error) {
	r.ensureCalls++
	if len(r.invite.Handle) == HandleBytes {
		return r.invite, nil
	}
	r.invite = invite
	return invite, nil
}

func (r *fakeRepository) GetInvite(context.Context, utilities.ID, utilities.ID) (Invite, error) {
	if r.getInviteErr != nil {
		return Invite{}, r.getInviteErr
	}
	return r.invite, nil
}

func (r *fakeRepository) GetInviteByHandle(context.Context, []byte) (Invite, error) {
	if r.inviteByHandle.Handle == nil {
		return Invite{}, ErrInviteNotFound
	}
	return r.inviteByHandle, nil
}

func (r *fakeRepository) SetInviteEnabled(_ context.Context, _ utilities.ID, _ utilities.ID, enabled bool, _ utilities.ID) (Invite, error) {
	r.enabledCalls++
	if r.enabledErr != nil {
		err := r.enabledErr
		r.enabledErr = nil
		return Invite{}, err
	}
	r.enabled = enabled
	return r.enabledResult, nil
}

func (r *fakeRepository) RotateInvite(_ context.Context, _ utilities.ID, _ utilities.ID, handle []byte, _ utilities.ID, _ string) (Invite, error) {
	r.rotateCalls++
	if r.rotateErr != nil {
		err := r.rotateErr
		r.rotateErr = nil
		return Invite{}, err
	}
	r.rotatedHandle = append([]byte(nil), handle...)
	return r.rotateResult, nil
}

func (r *fakeRepository) CreateArrival(_ context.Context, arrival Arrival) (Arrival, error) {
	if !r.arrivalNotFound {
		return Arrival{}, ErrIdempotencyConflict
	}
	r.arrival = arrival
	r.arrivalNotFound = false
	return arrival, nil
}

func (r *fakeRepository) GetArrival(context.Context, utilities.ID) (Arrival, error) {
	if r.arrival.ArrivalHandle.IsZero() {
		return Arrival{}, ErrArrivalNotFound
	}
	return r.arrival, nil
}

func (r *fakeRepository) GetArrivalForCredential(_ context.Context, _ utilities.ID, credentialHash []byte) (Arrival, error) {
	if !bytes.Equal(r.arrival.GuestCredentialHash, credentialHash) {
		return Arrival{}, ErrArrivalNotFound
	}
	return r.arrival, nil
}

func (r *fakeRepository) GetArrivalByIdempotency(context.Context, utilities.ID, utilities.ID, string) (Arrival, error) {
	if r.arrivalNotFound {
		return Arrival{}, ErrArrivalNotFound
	}
	return r.arrival, nil
}

func (r *fakeRepository) UpdateArrivalState(_ context.Context, input UpdateArrivalStateInput) (Arrival, error) {
	r.arrival.State = input.State
	r.arrival.EpisodeID = input.EpisodeID
	r.arrival.ParticipantID = input.ParticipantID
	r.arrival.ParticipantGeneration = input.ParticipantGeneration
	r.arrival.Provider = input.Provider
	r.arrival.ProviderSubject = input.ProviderSubject
	return r.arrival, nil
}

func (r *fakeRepository) CreateAdmissionRequest(_ context.Context, request AdmissionRequest) (AdmissionRequest, error) {
	return request, nil
}

func (r *fakeRepository) GetAdmissionRequest(context.Context, utilities.ID, utilities.ID, utilities.ID) (AdmissionRequest, error) {
	return AdmissionRequest{}, ErrAdmissionRequestNotFound
}

func (r *fakeRepository) ListAdmissionRequests(context.Context, utilities.ID, utilities.ID, AdmissionRequestState, int32) ([]AdmissionRequest, error) {
	return nil, nil
}

func (r *fakeRepository) DecideAdmissionRequest(_ context.Context, input DecideAdmissionRequestInput) (AdmissionRequest, Arrival, error) {
	if r.decisionErr != nil {
		return AdmissionRequest{}, Arrival{}, r.decisionErr
	}
	request := r.decisionRequest
	if request.RequestHandle.IsZero() {
		request = AdmissionRequest{RequestHandle: input.RequestHandle}
	}
	if input.Decision == DecisionApprove {
		request.State = AdmissionRequestApproved
		r.arrival.State = ArrivalPending
	} else {
		request.State = AdmissionRequestDenied
		r.arrival.State = ArrivalRejected
	}
	arrival := r.decisionArrival
	if arrival.ArrivalHandle.IsZero() {
		arrival = r.arrival
	}
	return request, arrival, nil
}

type fakeLifecycle struct {
	created AutoLifecycle
	retry   RetryAutoLifecycleInput
}

func (r *fakeLifecycle) CreateAutoLifecycle(_ context.Context, lifecycle AutoLifecycle) (AutoLifecycle, error) {
	r.created = lifecycle
	return lifecycle, nil
}

func (r *fakeLifecycle) GetAutoLifecycle(context.Context, utilities.ID, utilities.ID) (AutoLifecycle, error) {
	return r.created, nil
}

func (r *fakeLifecycle) ListDueAutoLifecycles(context.Context, time.Time, int32) ([]AutoLifecycle, error) {
	return []AutoLifecycle{r.created}, nil
}

func (r *fakeLifecycle) MarkAutoLifecycleArchiving(context.Context, utilities.ID, utilities.ID) (AutoLifecycle, error) {
	r.created.State = AutoLifecycleArchiving
	return r.created, nil
}

func (r *fakeLifecycle) MarkAutoLifecycleArchived(context.Context, utilities.ID, utilities.ID) (AutoLifecycle, error) {
	r.created.State = AutoLifecycleArchived
	return r.created, nil
}

func (r *fakeLifecycle) RetryAutoLifecycle(_ context.Context, input RetryAutoLifecycleInput) (AutoLifecycle, error) {
	r.retry = input
	r.created.RetryCount++
	r.created.NextRetryAt = &input.NextRetryAt
	r.created.LastErrorFamily = input.ErrorFamily
	return r.created, nil
}

type fakeSpace struct {
	space       PublicSpace
	createErr   error
	createdWith CreatePublicSpaceInput
}

func (s *fakeSpace) CreatePublicSpace(_ context.Context, input CreatePublicSpaceInput) (PublicSpace, error) {
	s.createdWith = input
	if s.createErr != nil {
		return PublicSpace{}, s.createErr
	}
	return s.space, nil
}

func (s *fakeSpace) GetPublicSpace(_ context.Context, _, _ utilities.ID) (PublicSpace, error) {
	return s.space, nil
}

type fakeAccess struct {
	grant        PublicAccessGrant
	refresh      PublicAccessGrant
	grantErr     error
	refreshErr   error
	revokeErr    error
	grantCalls   int
	refreshCalls int
	revokeCalls  int
	lastInput    PublicAccessInput
}

func (a *fakeAccess) GrantPublicAccess(_ context.Context, input PublicAccessInput) (PublicAccessGrant, error) {
	a.grantCalls++
	a.lastInput = input
	if a.grantErr != nil {
		return PublicAccessGrant{}, a.grantErr
	}
	return a.grant, nil
}

func (a *fakeAccess) RefreshPublicAccess(_ context.Context, input PublicAccessInput) (PublicAccessGrant, error) {
	a.refreshCalls++
	a.lastInput = input
	if a.refreshErr != nil {
		return PublicAccessGrant{}, a.refreshErr
	}
	if a.refresh == (PublicAccessGrant{}) {
		return a.grant, nil
	}
	return a.refresh, nil
}

func (a *fakeAccess) RevokePublicAccess(_ context.Context, input PublicAccessInput) error {
	a.revokeCalls++
	a.lastInput = input
	return a.revokeErr
}

type fakeAccounts struct {
	authorized bool
	err        error
	calls      int
	accountID  utilities.ID
	tenantID   utilities.ID
}

func (a *fakeAccounts) AuthorizePublicAccount(_ context.Context, accountID, tenantID utilities.ID) (bool, error) {
	a.calls++
	a.accountID = accountID
	a.tenantID = tenantID
	return a.authorized, a.err
}

type fakeLinks struct {
	err   error
	slug  string
	token string
}

func (l *fakeLinks) SpaceInviteURL(slug, token string) (string, error) {
	l.slug = slug
	l.token = token
	if l.err != nil {
		return "", l.err
	}
	return "https://invite.test/space/" + slug + "#spaceInviteToken=" + token, nil
}

func testIDs(t *testing.T) (utilities.ID, utilities.ID, utilities.ID) {
	t.Helper()
	return mustID(t, "11111111-1111-4111-8111-111111111111"), mustID(t, "22222222-2222-4222-8222-222222222222"), mustID(t, "33333333-3333-4333-8333-333333333333")
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func bytesOf(value byte, length int) []byte {
	result := make([]byte, length)
	for index := range result {
		result[index] = value
	}
	return result
}

func mustJSON(t *testing.T, value payload) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func flipLast(value string) string {
	if value == "A" {
		return "B"
	}
	return "A"
}
