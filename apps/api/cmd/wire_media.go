package main

import (
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	mediaplaneprovideradapter "github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/providerbridgeserver"
	"github.com/q9labs/chalk/apps/api/internal/recordingorchestrator"
	"github.com/q9labs/chalk/apps/api/internal/spiffe"
)

func (w *apiWiring) wireMediaPlane() error {
	w.mediaPlaneRegistry = mediaplaneprovideradapter.NewRegistry(mediaplaneprovideradapter.Config{
		TURN:      w.cfg.TURN,
		Telemetry: w.mediaPlaneTelemetry,
		ChalkSFU:  w.chalkSFU,
		Episodes:  w.options.Episodes,
		Recovery:  postgres.NewEpisodeRecovery(w.pool),
	})
	w.options.MediaPlane = w.mediaPlaneRegistry
	return nil
}

func (w *apiWiring) wireProviderBridge() error {
	// The Episode binding picks the node for grants, revokes and cleanup. A typed nil
	// adapter inside the interface would pass the nil check, so the nil case stays a
	// nil interface.
	if w.chalkSFU != nil {
		w.chalkNodes = providerbridge.ChalkNodesOf(func(node string, generation int64) (*chalksfu.Adapter, error) {
			return w.chalkSFU.Allocation(node, "", generation)
		})
	}
	if w.cfg.ProviderBridge.Enabled {
		recordingController := recordingorchestrator.NewController(w.recordingPipelineService)
		executor := providerbridge.NewSFUExecutor(w.mediaPublicationService, nil, recordingController)
		executor = executor.WithChalkSFU(postgres.NewEpisodeBindings(w.pool), w.chalkNodes).WithRetiredAllocations(w.mediaPlaneRegistry.EndRetiredAllocations).WithSessionOutcomes(postgres.NewSessionOutcomes(w.pool))
		providerBridgeService := providerbridge.NewService(w.providerOperationRepository, executor)
		verifier, err := spiffe.NewVerifier(w.cfg.ProviderBridge.SPIFFETrustDomain, w.cfg.Observability.Environment)
		if err != nil {
			return fmt.Errorf("configure provider bridge Sync identity: %w", err)
		}
		providerBridgeHandler := httpapi.NewProviderBridgeHandler(providerBridgeService, verifier.ForRole(spiffe.RoleSync))
		privateWorkerHandler := w.diagnostics.WrapHTTP(httpapi.NewPrivateWorkerRouter(providerBridgeHandler, w.options))
		w.providerBridgeServer, err = providerbridgeserver.New(w.cfg.ProviderBridge, privateWorkerHandler)
		if err != nil {
			return fmt.Errorf("configure provider bridge listener: %w", err)
		}
	}
	return nil
}
