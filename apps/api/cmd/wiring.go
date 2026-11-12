package main

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	sfuadapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	mediaplaneprovideradapter "github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	postgressqlc "github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/providerbridgeserver"
	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

// wiring builds the API process one stage at a time. Each stage fills the
// router options it owns and keeps in a field only what a later stage reads.
// Stage order is dependency order.
type wiring struct {
	cfg   config.Config
	obs   observed
	pool  *pgxpool.Pool
	redis *goredis.Client

	// queries are the pool's queries with operation logging applied.
	queries postgressqlc.Querier
	opts    httpapi.Options
	jobs    []backgroundJob

	tenantRepository            postgres.TenantRepository
	tenants                     tenants.Service
	tenantAuthz                 authorization.TenantPolicy
	spaces                      spaces.Service
	publicInvite                config.PublicInviteConfig
	chalkSFU                    *chalksfu.Fleet
	ownCapture                  bool
	episodeMediaBindingResolver mediaplaneprovideradapter.Registry
	episodeRepository           postgres.EpisodeLifecycleRepository
	episodes                    episodes.Service
	mediaPlaneRegistry          mediaplaneprovideradapter.Registry
	providerOperations          postgres.ProviderOperationRepository
	mediaPublications           mediapublications.Service

	syncParticipantVerifier  synctokens.Verifier
	syncVerifierConfigured   bool
	participantMediaRecovery publicinviteapp.MediaProofRecoveryVerifier

	managedSFU          sfuadapter.Adapter
	recordingRepository postgres.RecordingPipelineRepository
	recordingPipeline   recordingpipeline.Service
	recordingKMS        recordingkeys.KMS
	dispatcherWake      recordingrender.DispatcherWake
	storage             *objectstorage.Service
	transcripts         transcripts.Service

	providerBridge *providerbridgeserver.Server
	handler        http.Handler
}

func (w *wiring) build() error {
	w.queries = w.obs.diagnostics.Queries(postgressqlc.New(w.pool))
	for _, stage := range []func() error{
		w.buildCore,
		w.buildParticipantAuth,
		w.buildRecordingFleet,
		w.buildObjectStorage,
		w.buildRecordingAuthority,
		w.buildWebhooks,
		w.buildTranscription,
		w.buildRecordingRender,
		w.buildPublicInvites,
		w.buildHTTP,
		w.buildProviderBridge,
		w.buildAuthAndRouter,
	} {
		if err := stage(); err != nil {
			return err
		}
	}
	return nil
}
