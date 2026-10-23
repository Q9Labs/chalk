package httpapi

import (
	"context"
	"crypto/ed25519"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestInviteLazyCreationUsesWriteBudget(t *testing.T) {
	for _, ceiling := range []bool{false, true} {
		t.Run(map[bool]string{false: "tenant", true: "service_ceiling"}[ceiling], func(t *testing.T) {
			tenant := mustTestID(t, "00000000-0000-4000-8000-00000000000a")
			existing := mustTestID(t, "00000000-0000-4000-8000-00000000000b")
			missing := mustTestID(t, "00000000-0000-4000-8000-00000000000c")
			repo := &inviteBudgetRepository{invite: publicinvites.Invite{TenantID: tenant, SpaceID: existing, Handle: make([]byte, publicinvites.HandleBytes), Generation: 1, StateEpoch: 1, PublicRole: publicinvites.PublicRoleCollaborator, AdmissionMode: publicinvites.AdmissionOpen}}
			private := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
			signer, err := publicinvites.NewSigner(publicinvites.Keyring{CurrentKeyID: "test", Signer: private, Verifiers: map[string]ed25519.PublicKey{"test": private.Public().(ed25519.PublicKey)}})
			if err != nil {
				t.Fatal(err)
			}
			runtime, err := publicinvites.NewRuntime(publicinvites.NewService(repo, signer), inviteBudgetSpace{}, inviteBudgetLifecycle{}, inviteBudgetAccess{}, inviteBudgetAccounts{}, inviteBudgetLinks{})
			if err != nil {
				t.Fatal(err)
			}
			options := DefaultRateLimitOptions()
			now := time.Unix(1000, 0)
			options.Now = func() time.Time { return now }
			policy := authenticatedWriteRateLimit
			key := "principal:service:test:tenant:" + tenant.String()
			if ceiling {
				policy.Name += ".service_ceiling"
				policy.Limit = serviceWriteCeiling
				key = "principal:service:test"
			}
			for i := 0; i < policy.Limit; i++ {
				options.Limiter.Allow(context.Background(), key, policy, now)
			}
			router := chi.NewRouter()
			getSpacePublicInviteEndpoint(runtime, &preparationAuthorizer{}).Mount(router, options)
			request := func(space utilities.ID) *httptest.ResponseRecorder {
				r := httptest.NewRequest(http.MethodGet, "/tenants/"+tenant.String()+"/spaces/"+space.String()+"/public-invite", nil)
				r = r.WithContext(authentication.ContextWithPrincipal(r.Context(), authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "test"}))
				w := httptest.NewRecorder()
				router.ServeHTTP(w, r)
				return w
			}
			if w := request(existing); w.Code != http.StatusOK {
				t.Fatalf("existing invite read with exhausted writes: %d %s", w.Code, w.Body.String())
			}
			w := request(missing)
			if w.Code != http.StatusTooManyRequests || repo.creates != 0 || w.Header().Get(ratelimit.HeaderRetryAfter) == "" {
				t.Fatalf("lazy create: status=%d inserts=%d Retry-After=%q body=%s", w.Code, repo.creates, w.Header().Get(ratelimit.HeaderRetryAfter), w.Body.String())
			}
			options.Limiter = ratelimit.NewLocalLimiter()
			router = chi.NewRouter()
			getSpacePublicInviteEndpoint(runtime, &preparationAuthorizer{}).Mount(router, options)
			if w := request(missing); w.Code != http.StatusOK || repo.creates != 1 {
				t.Fatalf("available creation: status=%d inserts=%d", w.Code, repo.creates)
			}
			for i := 0; i < policy.Limit-1; i++ {
				if options.Limiter.Allow(context.Background(), key, policy, now).State != ratelimit.Allowed {
					t.Fatalf("creation spent more than one write at %d", i)
				}
			}
			if options.Limiter.Allow(context.Background(), key, policy, now).State == ratelimit.Allowed {
				t.Fatal("creation did not spend a write")
			}
		})
	}
}

type inviteBudgetRepository struct {
	publicinvites.Repository
	invite  publicinvites.Invite
	creates int
}

func (r *inviteBudgetRepository) GetInvite(_ context.Context, _ utilities.ID, space utilities.ID) (publicinvites.Invite, error) {
	if space == r.invite.SpaceID {
		return r.invite, nil
	}
	return publicinvites.Invite{}, publicinvites.ErrInviteNotFound
}
func (r *inviteBudgetRepository) CreateOrGetInvite(_ context.Context, invite publicinvites.Invite) (publicinvites.Invite, error) {
	r.creates++
	return invite, nil
}

type inviteBudgetSpace struct{ publicinvites.Space }

func (inviteBudgetSpace) GetPublicSpace(_ context.Context, tenant, space utilities.ID) (publicinvites.PublicSpace, error) {
	return publicinvites.PublicSpace{TenantID: tenant, SpaceID: space, Name: "Call", Slug: "call", AdmissionMode: publicinvites.AdmissionOpen}, nil
}

type inviteBudgetLifecycle struct{ publicinvites.Lifecycle }
type inviteBudgetAccess struct{ publicinvites.Access }
type inviteBudgetAccounts struct{ publicinvites.Accounts }
type inviteBudgetLinks struct{}

func (inviteBudgetLinks) SpaceInviteURL(string, string) (string, error) {
	return "https://example.test/call", nil
}
