package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestArrivalStatusCannotInvalidateWithExhaustedWrites(t *testing.T) {
	tenant := mustTestID(t, "00000000-0000-4000-8000-00000000000a")
	space := mustTestID(t, "00000000-0000-4000-8000-00000000000b")
	handle := mustTestID(t, "00000000-0000-4000-8000-00000000000c")
	credential := []byte("arrival-budget-credential")
	repo := &arrivalBudgetRepository{arrival: publicinvites.Arrival{TenantID: tenant, SpaceID: space, ArrivalHandle: handle, IdentityMode: publicinvites.IdentityGuest, State: publicinvites.ArrivalPending, ExpiresAt: time.Now().Add(time.Hour)}, hash: sha256.Sum256(credential)}
	private := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	signer, err := publicinvites.NewSigner(publicinvites.Keyring{CurrentKeyID: "test", Signer: private, Verifiers: map[string]ed25519.PublicKey{"test": private.Public().(ed25519.PublicKey)}})
	if err != nil {
		t.Fatal(err)
	}
	// The Space has switched from knock to open; GET status must invalidate the
	// pending guest arrival, exercising the actual production Runtime write path.
	runtime, err := publicinvites.NewRuntime(publicinvites.NewService(repo, signer), inviteBudgetSpace{}, inviteBudgetLifecycle{}, inviteBudgetAccess{}, inviteBudgetAccounts{}, inviteBudgetLinks{})
	if err != nil {
		t.Fatal(err)
	}
	options := DefaultRateLimitOptions()
	now := time.Now()
	options.Now = func() time.Time { return now }
	for i := 0; i < authenticatedWriteRateLimit.Limit; i++ {
		options.Limiter.Allow(context.Background(), "ip:192.0.2.1", authenticatedWriteRateLimit, now)
	}
	router := chi.NewRouter()
	publicInviteArrivalStatusEndpoint(runtime).Mount(router, options)
	req := httptest.NewRequest(http.MethodGet, "/public/space-invite-arrival", nil)
	req.RemoteAddr = "192.0.2.1:1234"
	req.Header.Set(publicInviteTokenHeader, handle.String())
	req.AddCookie(&http.Cookie{Name: publicGuestCookiePrefix + handle.String(), Value: base64.RawURLEncoding.EncodeToString(credential)})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	if response.Code != http.StatusTooManyRequests || repo.updates != 0 {
		t.Fatalf("GET with exhausted WRITE budget: status=%d persistent_updates=%d body=%s", response.Code, repo.updates, response.Body.String())
	}
}

type arrivalBudgetRepository struct {
	publicinvites.Repository
	arrival      publicinvites.Arrival
	hash         [32]byte
	updates      int
	requestState publicinvites.AdmissionRequestState
}

func (r *arrivalBudgetRepository) GetArrival(context.Context, utilities.ID) (publicinvites.Arrival, error) {
	return r.arrival, nil
}
func (r *arrivalBudgetRepository) GetArrivalForCredential(_ context.Context, _ utilities.ID, hash []byte) (publicinvites.Arrival, error) {
	if string(hash) != string(r.hash[:]) {
		return publicinvites.Arrival{}, publicinvites.ErrArrivalNotFound
	}
	return r.arrival, nil
}
func (r *arrivalBudgetRepository) UpdateArrivalState(_ context.Context, input publicinvites.UpdateArrivalStateInput) (publicinvites.Arrival, error) {
	r.updates++
	r.arrival.State = input.State
	r.arrival.EpisodeID, r.arrival.ParticipantID, r.arrival.ParticipantGeneration = input.EpisodeID, input.ParticipantID, input.ParticipantGeneration
	r.arrival.Provider, r.arrival.ProviderSubject = input.Provider, input.ProviderSubject
	return r.arrival, nil
}

func (r *arrivalBudgetRepository) GetAdmissionRequestForArrival(context.Context, publicinvites.Arrival) (publicinvites.AdmissionRequest, error) {
	if r.requestState == "" {
		return publicinvites.AdmissionRequest{}, publicinvites.ErrAdmissionRequestNotFound
	}
	return publicinvites.AdmissionRequest{State: r.requestState}, nil
}

func TestArrivalStatusTerminalAdmissionRequiresWriteBudget(t *testing.T) {
	for _, state := range []publicinvites.AdmissionRequestState{publicinvites.AdmissionRequestApproved, publicinvites.AdmissionRequestDenied, publicinvites.AdmissionRequestExpired, publicinvites.AdmissionRequestInvalidated, publicinvites.AdmissionRequestPending} {
		t.Run(string(state), func(t *testing.T) {
			tenant := mustTestID(t, "00000000-0000-4000-8000-00000000000a")
			space := mustTestID(t, "00000000-0000-4000-8000-00000000000b")
			handle := mustTestID(t, "00000000-0000-4000-8000-00000000000c")
			credential := []byte("arrival-terminal-budget-credential")
			repo := &arrivalBudgetRepository{arrival: publicinvites.Arrival{TenantID: tenant, SpaceID: space, ArrivalHandle: handle, IdentityMode: publicinvites.IdentityGuest, State: publicinvites.ArrivalPending, ExpiresAt: time.Now().Add(time.Hour)}, hash: sha256.Sum256(credential), requestState: state}
			private := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
			signer, err := publicinvites.NewSigner(publicinvites.Keyring{CurrentKeyID: "test", Signer: private, Verifiers: map[string]ed25519.PublicKey{"test": private.Public().(ed25519.PublicKey)}})
			if err != nil {
				t.Fatal(err)
			}
			access := &arrivalBudgetAccess{}
			runtime, err := publicinvites.NewRuntime(publicinvites.NewService(repo, signer), arrivalBudgetSpace{}, inviteBudgetLifecycle{}, access, inviteBudgetAccounts{}, inviteBudgetLinks{})
			if err != nil {
				t.Fatal(err)
			}
			options := DefaultRateLimitOptions()
			now := time.Now()
			options.Now = func() time.Time { return now }
			key := "ip:192.0.2.1"
			for i := 0; i < authenticatedWriteRateLimit.Limit; i++ {
				options.Limiter.Allow(context.Background(), key, authenticatedWriteRateLimit, now)
			}
			request := func() *httptest.ResponseRecorder {
				router := chi.NewRouter()
				publicInviteArrivalStatusEndpoint(runtime).Mount(router, options)
				req := httptest.NewRequest(http.MethodGet, "/public/space-invite-arrival", nil)
				req.RemoteAddr = "192.0.2.1:1234"
				req.Header.Set(publicInviteTokenHeader, handle.String())
				req.AddCookie(&http.Cookie{Name: publicGuestCookiePrefix + handle.String(), Value: base64.RawURLEncoding.EncodeToString(credential)})
				response := httptest.NewRecorder()
				router.ServeHTTP(response, req)
				return response
			}
			pending := state == publicinvites.AdmissionRequestPending
			wantStatus := http.StatusTooManyRequests
			if pending {
				wantStatus = http.StatusOK
			}
			if response := request(); response.Code != wantStatus || repo.updates != 0 || access.grants != 0 {
				t.Fatalf("exhausted writes: status=%d updates=%d grants=%d body=%s", response.Code, repo.updates, access.grants, response.Body.String())
			}
			options.Limiter = ratelimit.NewLocalLimiter()
			if response := request(); response.Code != http.StatusOK {
				t.Fatalf("available writes: status=%d body=%s", response.Code, response.Body.String())
			}
			wantUpdates := 1
			if pending {
				wantUpdates = 0
			}
			if repo.updates != wantUpdates {
				t.Fatalf("persistent updates=%d want%d", repo.updates, wantUpdates)
			}
			for i := 0; i < authenticatedWriteRateLimit.Limit-wantUpdates; i++ {
				if options.Limiter.Allow(context.Background(), key, authenticatedWriteRateLimit, now).State != ratelimit.Allowed {
					t.Fatal("status spent too many writes")
				}
			}
			if options.Limiter.Allow(context.Background(), key, authenticatedWriteRateLimit, now).State == ratelimit.Allowed {
				t.Fatal("terminal resolution did not spend one write")
			}
		})
	}
}

type arrivalBudgetSpace struct{ publicinvites.Space }

func (arrivalBudgetSpace) GetPublicSpace(_ context.Context, tenant, space utilities.ID) (publicinvites.PublicSpace, error) {
	return publicinvites.PublicSpace{TenantID: tenant, SpaceID: space, Name: "Call", Slug: "call", AdmissionMode: publicinvites.AdmissionKnock}, nil
}

type arrivalBudgetAccess struct {
	publicinvites.Access
	grants int
	grant  *publicinvites.PublicAccessGrant
	inputs []publicinvites.Arrival
}

func (a *arrivalBudgetAccess) GrantPublicAccess(_ context.Context, input publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error) {
	a.grants++
	a.inputs = append(a.inputs, input.Arrival)
	if a.grant != nil {
		return *a.grant, nil
	}
	return publicinvites.PublicAccessGrant{}, publicinvites.ErrArrivalUnavailable
}

func TestArrivalStatusRetryReissuesAdmittedAccess(t *testing.T) {
	tenant := mustTestID(t, "00000000-0000-4000-8000-00000000000a")
	space := mustTestID(t, "00000000-0000-4000-8000-00000000000b")
	handle := mustTestID(t, "00000000-0000-4000-8000-00000000000c")
	episode := mustTestID(t, "00000000-0000-4000-8000-00000000000d")
	participant := mustTestID(t, "00000000-0000-4000-8000-00000000000e")
	credential := []byte("lost-status-response-credential")
	repo := &arrivalBudgetRepository{arrival: publicinvites.Arrival{TenantID: tenant, SpaceID: space, ArrivalHandle: handle, IdentityMode: publicinvites.IdentityGuest, State: publicinvites.ArrivalPending, ExpiresAt: time.Now().Add(time.Hour)}, hash: sha256.Sum256(credential), requestState: publicinvites.AdmissionRequestApproved}
	grant := publicinvites.PublicAccessGrant{TenantID: tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant, ParticipantGeneration: 7, Provider: publicinvites.PublicProviderCloudflareSFU, ProviderSubject: "stored-connection", SyncToken: "fixture-sync", MediaToken: "fixture-media", ClientPayload: publicinvites.PublicAccessClientPayload{ConnectionID: "stored-connection", StunServer: "stun:fixture"}, ExpiresAt: time.Now().Add(time.Hour)}
	access := &arrivalBudgetAccess{grant: &grant}
	runtime, err := publicinvites.NewRuntime(publicinvites.NewService(repo), arrivalBudgetSpace{}, inviteBudgetLifecycle{}, access, inviteBudgetAccounts{}, inviteBudgetLinks{})
	if err != nil {
		t.Fatal(err)
	}
	options := DefaultRateLimitOptions()
	now := time.Now()
	options.Now = func() time.Time { return now }
	request := func() *httptest.ResponseRecorder {
		router := chi.NewRouter()
		publicInviteArrivalStatusEndpoint(runtime).Mount(router, options)
		req := httptest.NewRequest(http.MethodGet, "/public/space-invite-arrival", nil)
		req.RemoteAddr = "192.0.2.1:1234"
		req.Header.Set(publicInviteTokenHeader, handle.String())
		req.AddCookie(&http.Cookie{Name: publicGuestCookiePrefix + handle.String(), Value: base64.RawURLEncoding.EncodeToString(credential)})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	// The first response is lost after its admission transition commits.
	for attempt := 0; attempt < 2; attempt++ {
		response := request()
		var result publicSpaceArrivalResponse
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusOK || result.Access == nil || result.Access.Subject.ParticipantID != participant.String() || result.Access.Subject.EpisodeID != episode.String() || result.Access.Subject.ParticipantGeneration != 7 {
			t.Fatalf("admitted status attempt %d: status=%d body=%s", attempt, response.Code, response.Body.String())
		}
	}
	if repo.updates != 1 || access.grants != 2 || access.inputs[1].EpisodeID != episode || access.inputs[1].ParticipantID != participant || access.inputs[1].ProviderSubject != grant.ProviderSubject {
		t.Fatalf("retry did not resume stored binding: updates=%d grants=%d inputs=%+v", repo.updates, access.grants, access.inputs)
	}
	for i := 0; i < authenticatedWriteRateLimit.Limit-2; i++ {
		options.Limiter.Allow(context.Background(), "ip:192.0.2.1", authenticatedWriteRateLimit, now)
	}
	if response := request(); response.Code != http.StatusTooManyRequests || access.grants != 2 || repo.updates != 1 {
		t.Fatalf("retry bypassed write budget: status=%d grants=%d updates=%d", response.Code, access.grants, repo.updates)
	}
}
