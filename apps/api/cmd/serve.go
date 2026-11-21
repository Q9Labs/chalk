package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

type serverResults struct {
	server                 <-chan error
	providerBridge         <-chan error
	dispatcher             <-chan error
	deadlineScheduler      <-chan error
	recordingMaintenance   <-chan error
	whiteboardCleanup      <-chan error
	chatCleanup            <-chan error
	recordingSourceCleanup <-chan error
	publicInviteLifecycle  <-chan error
	receiveHealthDone      <-chan struct{}
}

func (w *apiWiring) serve(server *http.Server) error {
	signalCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	defer startEvidenceRelay(signalCtx, w.telemetryLedger, w.evidenceSink, w.logger)()
	results, err := w.startServersAndWorkers(signalCtx, server)
	if err != nil {
		return err
	}
	return w.awaitShutdown(signalCtx, stop, server, results)
}

func (w *apiWiring) startServersAndWorkers(signalCtx context.Context, server *http.Server) (serverResults, error) {
	if w.chalkSFU != nil {
		// Placement reads node load from these probes; the first round ends before the server takes a request.
		w.chalkSFU.Probe(signalCtx)
		go w.chalkSFU.Watch(signalCtx)
		// Chalk SFU nodes forward a source only while the API renews its grant.
		go providerbridge.NewSourceLeases(postgres.NewSourceGrants(w.pool), w.chalkNodes).Run(signalCtx)
		// Retires owed to the allocations Episodes left are paid until each node acknowledges.
		go w.mediaPlaneRegistry.RunRetirements(signalCtx)
	}
	go observability.RunMediaPlaneChangeRelay(signalCtx, postgres.NewChangeLedger(w.pool))
	receiveHealthDone := make(chan struct{})
	go func() {
		w.mediaPublicationService.RunReceiveHealth(signalCtx)
		close(receiveHealthDone)
	}()
	dispatcherOwner, err := utilities.NewID()
	if err != nil {
		return serverResults{}, fmt.Errorf("create webhook dispatcher owner: %w", err)
	}
	dispatcher := webhooks.NewDispatcher(postgres.NewWebhookDispatchRepository(w.pool), w.webhookProtector, webhooks.NewDeliveryClient(nil), dispatcherOwner.String(), w.logger)
	dispatcherErr := startWorker(signalCtx, dispatcher.Run)
	deadlineScheduler := episodes.NewDeadlineScheduler(w.episodeRepository, w.cfg.DeadlineScheduler.Interval, w.cfg.DeadlineScheduler.Batch)
	deadlineSchedulerErr := startWorker(signalCtx, deadlineScheduler.Run)
	var recordingMaintenanceErr <-chan error
	if w.cfg.Capabilities.Recording {
		recordingMaintenanceErr = startWorker(signalCtx, func(ctx context.Context) error {
			return w.recordingPipelineService.RunMaintenance(ctx, recordingpipeline.DefaultMaintenanceInterval)
		})
	}

	var whiteboardCleanupErr <-chan error
	if w.whiteboardCleanupScheduler != nil {
		whiteboardCleanupErr = startWorker(signalCtx, w.whiteboardCleanupScheduler.Run)
	}
	var chatCleanupErr <-chan error
	if w.chatCleanupScheduler != nil {
		chatCleanupErr = startWorker(signalCtx, w.chatCleanupScheduler.Run)
	}
	var recordingSourceCleanupErr <-chan error
	if w.recordingSourceCleanupScheduler != nil {
		recordingSourceCleanupErr = startWorker(signalCtx, w.recordingSourceCleanupScheduler.Run)
	}
	var publicInviteLifecycleErr <-chan error
	if w.publicInviteLifecycleScheduler != nil {
		publicInviteLifecycleErr = startWorker(signalCtx, w.publicInviteLifecycleScheduler.Run)
	}
	var providerBridgeErr <-chan error
	if w.providerBridgeServer != nil {
		providerBridgeErr, err = w.providerBridgeServer.Start()
		if err != nil {
			return serverResults{}, fmt.Errorf("start provider bridge listener: %w", err)
		}
		w.logger.Info("provider bridge listening", "event", "provider_bridge.listening", "address", w.providerBridgeServer.Address())
	}

	serverErr := make(chan error, 1)
	go func() {
		w.logger.Info("api listening", "event", "api.listening", "address", w.cfg.API.Address)

		err := server.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			w.logger.Error("api listen failed", "event", "api.listen_failed", "error", err.Error())
			serverErr <- err
			return
		}

		serverErr <- nil
	}()
	return serverResults{
		server: serverErr, providerBridge: providerBridgeErr,
		dispatcher: dispatcherErr, deadlineScheduler: deadlineSchedulerErr, recordingMaintenance: recordingMaintenanceErr,
		whiteboardCleanup: whiteboardCleanupErr, chatCleanup: chatCleanupErr,
		recordingSourceCleanup: recordingSourceCleanupErr, publicInviteLifecycle: publicInviteLifecycleErr,
		receiveHealthDone: receiveHealthDone,
	}, nil
}

func startWorker(ctx context.Context, run func(context.Context) error) <-chan error {
	done := make(chan error, 1)
	go func() { done <- run(ctx) }()
	return done
}

func (w *apiWiring) awaitShutdown(signalCtx context.Context, stop context.CancelFunc, server *http.Server, results serverResults) error {
	var runErr error
	select {
	case err := <-results.server:
		runErr = err
		results.server = nil
	case err := <-results.providerBridge:
		runErr = err
		results.providerBridge = nil
		if err != nil {
			w.logger.Error("provider bridge listen failed", "event", "provider_bridge.listen_failed", "error", err.Error())
		}
	case err := <-results.dispatcher:
		runErr = err
	case err := <-results.deadlineScheduler:
		runErr = err
	case err := <-results.recordingMaintenance:
		runErr = err
		results.recordingMaintenance = nil

	case err := <-results.whiteboardCleanup:
		runErr = err
		results.whiteboardCleanup = nil
	case err := <-results.chatCleanup:
		runErr = err
		results.chatCleanup = nil
	case err := <-results.recordingSourceCleanup:
		runErr = err
		results.recordingSourceCleanup = nil
	case err := <-results.publicInviteLifecycle:
		runErr = err
		results.publicInviteLifecycle = nil
	case <-signalCtx.Done():
	}
	stop()

	if err := w.shutdownServers(server); err != nil {
		return err
	}
	return results.drain(runErr)
}

func (w *apiWiring) shutdownServers(server *http.Server) error {
	shutdownStartedAt := time.Now()
	w.logger.Info("api shutdown requested", "event", "api.shutdown_requested")
	// Allow in-flight synchronous email delivery and its uniform response window
	// to finish before releasing the API dependencies.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		w.logger.Error("api shutdown failed", "event", "api.shutdown_failed", "error", err.Error())
		return fmt.Errorf("shutdown server: %w", err)
	}
	if w.providerBridgeServer != nil {
		if err := w.providerBridgeServer.Shutdown(shutdownCtx); err != nil {
			w.logger.Error("provider bridge shutdown failed", "event", "provider_bridge.shutdown_failed", "error", err.Error())
			return fmt.Errorf("shutdown provider bridge server: %w", err)
		}
		w.logger.Info("provider bridge shutdown complete", "event", "provider_bridge.shutdown_complete")
	}

	w.logger.Info("api shutdown complete",
		"event", "api.shutdown_complete",
		"duration_ms", float64(time.Since(shutdownStartedAt).Microseconds())/1000,
	)
	return nil
}

func (results serverResults) drain(runErr error) error {
	for _, done := range []<-chan error{
		results.server, results.providerBridge, results.whiteboardCleanup,
		results.chatCleanup, results.recordingSourceCleanup, results.publicInviteLifecycle,
		results.recordingMaintenance,
	} {
		if done != nil {
			if err := <-done; runErr == nil {
				runErr = err
			}
		}
	}
	<-results.receiveHealthDone
	return runErr
}
