//go:build mcp_eval

package postgres

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpreparation"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

// TestMCPEvalHost is an opt-in local composition root, not a mocked MCP server.
// All benchmarked operations use the same services/repositories as /v1. Unused
// media/admission issuance edges reuse the integration suite's provider fixtures.
func TestMCPEvalHost(t *testing.T) {
	if os.Getenv("CHALK_MCP_EVAL") != "1" {
		t.Skip("started only by scripts/evals/mcp/stack.sh")
	}
	databaseURL := os.Getenv("CHALK_DATABASE_URL")
	parsed, err := url.Parse(databaseURL)
	if err != nil || parsed.Hostname() != "127.0.0.1" || parsed.Path != "/chalk_mcp_eval" {
		t.Fatal("eval host requires loopback chalk_mcp_eval database")
	}
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var marker bool
	if err := pool.QueryRow(t.Context(), "select id from mcp_eval_marker where id").Scan(&marker); err != nil || !marker {
		t.Fatal("eval database marker missing")
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	q := sqlc.New(pool)
	keys := apikeys.NewService(NewAPIKeyRepository(q, pool), apikeys.Config{})
	spaceService := spaces.NewService(NewSpaceRepository(q, pool))
	tenantService := tenants.NewService(NewTenantRepository(q))
	binding, err := mediaplane.NewBinding("cf_sfu", mediaplane.BindingSourceDeploymentDefault, "eval-local")
	if err != nil {
		t.Fatal(err)
	}
	episodeRepo := NewEpisodeLifecycleRepositoryWithMediaBinding(pool, directAdmissionMedia{binding: binding})
	inviteRepo := NewPublicInviteRepositoryWithPool(pool).WithEpisodeLifecycle(episodeRepo)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := publicinvites.NewSigner(publicinvites.Keyring{CurrentKeyID: "eval", Signer: privateKey, Verifiers: map[string]ed25519.PublicKey{"eval": publicKey}})
	if err != nil {
		t.Fatal(err)
	}
	inviteService, err := publicinvites.NewServiceWithLifecycle(inviteRepo, inviteRepo, signer)
	if err != nil {
		t.Fatal(err)
	}
	managedTenant, err := utilities.ParseID("5328ec96-0d1b-4d6f-b028-678652812314")
	if err != nil {
		t.Fatal(err)
	}
	spacePort, err := publicinviteapp.NewSpacePort(spaceService, tenantService, publicinviteapp.SpaceConfig{ManagedTenantID: managedTenant, DefaultMediaPlane: "cf_sfu"})
	if err != nil {
		t.Fatal(err)
	}
	inviteRuntime, err := publicinvites.NewRuntime(inviteService, spacePort, inviteRepo, &terminalAdmissionAccess{}, admissionProofAccounts{}, admissionProofLinks{})
	if err != nil {
		t.Fatal(err)
	}
	encryptionKey := make([]byte, 32)
	if _, err := rand.Read(encryptionKey); err != nil {
		t.Fatal(err)
	}
	protector, err := webhooks.NewAESGCMProtector(encryptionKey)
	if err != nil {
		t.Fatal(err)
	}
	webhookService := webhooks.NewService(NewWebhookRepository(pool, protector), protector)
	transcriptRepo := NewTranscriptRepositoryWithPool(q, pool)
	options := httpapi.Options{
		APIKeys: keys, APIKeyAuthentication: keys,
		TenantAuthz: authorization.NewTenantPolicy(NewMembershipRepository(q, pool), NewTenantRepository(q)),
		Tenants:     tenantService, Memberships: memberships.NewService(NewMembershipRepository(q, pool)),
		Spaces: spaceService, Episodes: episodes.NewService(episodeRepo), PublicInvites: inviteRuntime,
		RecordingPreparations: recordingpreparation.NewService(NewRecordingPreparationRepository(pool), spaceService),
		Recordings:            recordings.NewService(NewRecordingRepository(q)),
		RecordingExports:      recordingpipeline.NewService(NewRecordingPipelineRepositoryWithPool(pool)),
		TranscriptArtifacts:   transcripts.NewArtifactService(transcriptRepo, transcriptRepo),
		Webhooks:              webhookService, RateLimit: httpapi.DefaultRateLimitOptions(),
	}
	options.RateLimit.DisableAuthenticated = true
	options.MCP = httpapi.NewMCPHandler(options)
	server := &http.Server{Addr: "127.0.0.1:18080", Handler: httpapi.NewRouter(options), ReadHeaderTimeout: 5 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		t.Fatal(err)
	}
}
