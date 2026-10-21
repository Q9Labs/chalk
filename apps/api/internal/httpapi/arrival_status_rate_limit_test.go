package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
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
	arrival publicinvites.Arrival
	hash    [32]byte
	updates int
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
	return r.arrival, nil
}
