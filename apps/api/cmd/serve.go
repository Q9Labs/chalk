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
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
)

// backgroundJob is a loop that runs for the life of the process. Any job that
// returns, with or without an error, starts shutdown. Shutdown waits for the
// awaited jobs to return before the process exits.
type backgroundJob struct {
	name    string
	awaited bool
	run     func(context.Context) error
}

type jobResult struct {
	job backgroundJob
	err error
}

// serve runs the API until a signal arrives or a job stops, then shuts down.
func (w *wiring) serve() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	w.startSFULoops(ctx)
	receiveHealthDone := make(chan struct{})
	go func() {
		w.mediaPublications.RunReceiveHealth(ctx)
		close(receiveHealthDone)
	}()

	if err := w.addProviderBridgeJob(); err != nil {
		return err
	}
	server := w.newServer()
	w.jobs = append(w.jobs, w.apiServerJob(server))

	runErr, err := w.superviseJobs(ctx, stop, server)
	if err != nil {
		return err
	}
	<-receiveHealthDone
	return runErr
}

func (w *wiring) addProviderBridgeJob() error {
	if w.providerBridge == nil {
		return nil
	}
	logger := w.obs.logger
	bridgeErr, err := w.providerBridge.Start()
	if err != nil {
		return fmt.Errorf("start provider bridge listener: %w", err)
	}
	logger.Info("provider bridge listening", "event", "provider_bridge.listening", "address", w.providerBridge.Address())
	w.jobs = append(w.jobs, backgroundJob{name: "provider bridge", awaited: true, run: func(context.Context) error {
		err := <-bridgeErr
		if err != nil {
			logger.Error("provider bridge listen failed", "event", "provider_bridge.listen_failed", "error", err.Error())
		}
		return err
	}})
	return nil
}

func (w *wiring) apiServerJob(server *http.Server) backgroundJob {
	logger := w.obs.logger
	return backgroundJob{name: "api server", awaited: true, run: func(context.Context) error {
		logger.Info("api listening", "event", "api.listening", "address", w.cfg.API.Address)
		err := server.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("api listen failed", "event", "api.listen_failed", "error", err.Error())
			return err
		}
		return nil
	}}
}

// superviseJobs runs every job until the first one stops or the context ends, then shuts the server down and
// waits for the awaited jobs. It returns the first job error; a shutdown failure comes back as the second value.
func (w *wiring) superviseJobs(ctx context.Context, stop context.CancelFunc, server *http.Server) (runErr error, shutdownErr error) {
	results := make(chan jobResult, len(w.jobs))
	for _, job := range w.jobs {
		go func() { results <- jobResult{job: job, err: job.run(ctx)} }()
	}
	pending := 0
	for _, job := range w.jobs {
		if job.awaited {
			pending++
		}
	}
	select {
	case first := <-results:
		runErr = first.err
		if first.job.awaited {
			pending--
		}
	case <-ctx.Done():
	}
	stop()

	if err := w.shutdown(server); err != nil {
		return nil, err
	}
	for pending > 0 {
		result := <-results
		if !result.job.awaited {
			continue
		}
		pending--
		if runErr == nil {
			runErr = result.err
		}
	}
	return runErr, nil
}

func (w *wiring) newServer() *http.Server {
	return &http.Server{
		Addr:              w.cfg.API.Address,
		Handler:           w.handler,
		ReadTimeout:       15 * time.Second,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}

// startSFULoops starts the loops that keep own SFU nodes placed and paid.
func (w *wiring) startSFULoops(ctx context.Context) {
	if w.chalkSFU == nil {
		return
	}
	// Placement reads node load from these probes. The first round finishes, within the probe
	// timeout, before the server takes a request; a node with no answer is not placed on.
	w.chalkSFU.Probe(ctx)
	go w.chalkSFU.Watch(ctx)
	// Own SFU nodes forward a source only while the API renews its grant.
	go providerbridge.NewSourceLeases(postgres.NewSourceGrants(w.pool), w.chalkNodes()).Run(ctx)
	// Retires owed to the allocations Episodes left are paid until each node acknowledges.
	go w.mediaPlaneRegistry.RunRetirements(ctx)
}

func (w *wiring) shutdown(server *http.Server) error {
	logger := w.obs.logger
	startedAt := time.Now()
	logger.Info("api shutdown requested", "event", "api.shutdown_requested")
	// Allow in-flight synchronous email delivery and its uniform response window
	// to finish before releasing the API dependencies.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		logger.Error("api shutdown failed", "event", "api.shutdown_failed", "error", err.Error())
		return fmt.Errorf("shutdown server: %w", err)
	}
	if w.providerBridge != nil {
		if err := w.providerBridge.Shutdown(ctx); err != nil {
			logger.Error("provider bridge shutdown failed", "event", "provider_bridge.shutdown_failed", "error", err.Error())
			return fmt.Errorf("shutdown provider bridge server: %w", err)
		}
		logger.Info("provider bridge shutdown complete", "event", "provider_bridge.shutdown_complete")
	}
	logger.Info("api shutdown complete", "event", "api.shutdown_complete", "duration_ms", float64(time.Since(startedAt).Microseconds())/1000)
	return nil
}
