package postgres

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

const spaceInviteTestOrigin = "https://invite.chalk.test"

type createSpaceNameRequest struct {
	Name                          string `json:"name"`
	Slug                          string `json:"slug"`
	MediaPlane                    string `json:"media_plane"`
	DefaultEpisodeDurationSeconds int32  `json:"default_episode_duration_seconds"`
	MaximumEpisodeDurationSeconds int32  `json:"maximum_episode_duration_seconds"`
	LingerWindowSeconds           int32  `json:"linger_window_seconds"`
}

type spaceNameResponse struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Slug  string `json:"slug"`
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

type spacePublicInviteNameResponse struct {
	CanonicalURL string `json:"canonical_url"`
	Enabled      bool   `json:"enabled"`
	Error        struct {
		Code string `json:"code"`
	} `json:"error"`
}

// A Space accepts any non-blank name, so its public invite must too. The test
// drives Space creation and the invite read through the HTTP router with real
// services and PostgreSQL; only the Cloudflare media allocation is absent
// because the invite endpoints never reach it.
func TestSpacePublicInviteAcceptsEverySpaceName(t *testing.T) {
	databaseURL := os.Getenv(config.DatabaseURL)
	if testing.Short() || databaseURL == "" {
		t.Skip("isolated PostgreSQL integration database is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tenantID := accountTenantIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Space invite name fixture')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into tenant_artifact_policies(tenant_id) values($1)`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}

	queries := sqlc.New(pool)
	keys := apikeys.NewService(NewAPIKeyRepository(queries, pool), apikeys.Config{})
	key, err := keys.Create(ctx, apikeys.CreateInput{
		TenantID:  tenantID,
		Name:      "Space invite name fixture",
		Scopes:    []authentication.Scope{authentication.ScopeSpacesRead, authentication.ScopeSpacesWrite},
		ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	const keyID = "space-invite-names"
	signer, err := publicinvites.NewSigner(publicinvites.Keyring{CurrentKeyID: keyID, Signer: privateKey, Verifiers: map[string]ed25519.PublicKey{keyID: publicKey}})
	if err != nil {
		t.Fatal(err)
	}
	inviteRepository := NewPublicInviteRepositoryWithPool(pool)
	inviteService, err := publicinvites.NewServiceWithLifecycle(inviteRepository, inviteRepository, signer)
	if err != nil {
		t.Fatal(err)
	}
	spaceService := spaces.NewService(NewSpaceRepository(queries, pool))
	tenantService := tenants.NewService(NewTenantRepository(queries))
	tenantPolicy := authorization.NewTenantPolicy(nil, nil)
	media := directAdmissionMedia{}
	episodeRepository := NewEpisodeLifecycleRepositoryWithMediaBinding(pool, media)
	syncSigner, err := synctokens.NewService(synctokens.Config{Issuer: "fixture", Audience: "fixture", KeyID: keyID, PrivateKey: privateKey})
	if err != nil {
		t.Fatal(err)
	}
	mediaTokens, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "fixture", KeyID: keyID, PrivateKey: privateKey})
	if err != nil {
		t.Fatal(err)
	}
	spacePort, err := publicinviteapp.NewSpacePort(spaceService, tenantService, publicinviteapp.SpaceConfig{ManagedTenantID: tenantID, DefaultMediaPlane: "cf_sfu"})
	if err != nil {
		t.Fatal(err)
	}
	accessPort, err := publicinviteapp.NewAccessPort(publicinviteapp.AccessConfig{
		Episodes: episodes.NewService(episodeRepository), Spaces: spaceService, Tenants: tenantService, MediaResolver: media,
		SyncTokens: synctokens.NewBroker(episodeRepository, syncSigner), MediaTokens: mediaTokens,
	})
	if err != nil {
		t.Fatal(err)
	}
	accountsPort, err := publicinviteapp.NewAccountsPort(tenantPolicy)
	if err != nil {
		t.Fatal(err)
	}
	linksPort, err := publicinviteapp.NewLinkPort(spaceInviteTestOrigin)
	if err != nil {
		t.Fatal(err)
	}
	runtime, err := publicinvites.NewRuntime(inviteService, spacePort, inviteRepository, accessPort, accountsPort, linksPort)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpapi.NewRouter(httpapi.Options{
		APIKeyAuthentication: keys, TenantAuthz: tenantPolicy, Spaces: spaceService, Tenants: tenantService, PublicInvites: runtime,
	}))
	defer server.Close()

	call := func(t *testing.T, method, path, requestKey string, body []byte, status int, out any) {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, server.URL+path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+key.RawKey)
		if requestKey != "" {
			req.Header.Set("Idempotency-Key", requestKey)
		}
		res, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != status {
			t.Fatalf("%s %s: status=%d want=%d body=%s", method, path, res.StatusCode, status, raw)
		}
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatal(err)
		}
	}

	names := []struct{ label, name string }{
		{"arabic", "اجتماع الفريق الأسبوعي"},
		{"chinese", "项目评审会议"},
		{"japanese", "週次ミーティング"},
		{"accented latin and chinese", "Réunion 会议"},
	}
	for index, tc := range names {
		t.Run(tc.label, func(t *testing.T) {
			body, err := json.Marshal(createSpaceNameRequest{
				Name: tc.name, Slug: fmt.Sprintf("invite-name-%d-%s", index, tenantID.String()[:8]), MediaPlane: "cf_sfu",
				DefaultEpisodeDurationSeconds: 3600, MaximumEpisodeDurationSeconds: 3600, LingerWindowSeconds: 0,
			})
			if err != nil {
				t.Fatal(err)
			}
			var created spaceNameResponse
			call(t, http.MethodPost, "/v1/tenants/"+tenantID.String()+"/spaces", fmt.Sprintf("space-invite-names-%d-%s", index, tenantID.String()), body, http.StatusCreated, &created)
			if created.Name != tc.name {
				t.Fatalf("Space name = %q, want %q", created.Name, tc.name)
			}

			var invite spacePublicInviteNameResponse
			call(t, http.MethodGet, "/v1/tenants/"+tenantID.String()+"/spaces/"+created.ID+"/public-invite", "", nil, http.StatusOK, &invite)
			if !invite.Enabled {
				t.Fatal("public invite is not enabled")
			}
			link, err := url.Parse(invite.CanonicalURL)
			if err != nil {
				t.Fatalf("invite URL %q does not parse: %v", invite.CanonicalURL, err)
			}
			if link.Scheme+"://"+link.Host != spaceInviteTestOrigin || link.Path != "/space/"+created.Slug {
				t.Fatalf("invite URL = %q, want %s/space/%s", invite.CanonicalURL, spaceInviteTestOrigin, created.Slug)
			}
			if !strings.HasPrefix(link.Fragment, "spaceInviteToken=cspi1.") {
				t.Fatalf("invite URL fragment = %q, want a cspi1 token", link.Fragment)
			}
			for _, character := range invite.CanonicalURL {
				if character > 0x7e {
					t.Fatalf("invite URL %q contains a non-ASCII character", invite.CanonicalURL)
				}
			}

			var again spacePublicInviteNameResponse
			call(t, http.MethodGet, "/v1/tenants/"+tenantID.String()+"/spaces/"+created.ID+"/public-invite", "", nil, http.StatusOK, &again)
			if again.CanonicalURL != invite.CanonicalURL {
				t.Fatalf("second invite read changed the URL: %q then %q", invite.CanonicalURL, again.CanonicalURL)
			}
		})
	}
}
