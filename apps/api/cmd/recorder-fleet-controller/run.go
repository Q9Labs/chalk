package main

import (
	"context"
	"crypto/x509"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/digitalocean"
	"github.com/q9labs/chalk/apps/api/internal/adapters/recorderfleetcontrol"
	"github.com/q9labs/chalk/apps/api/internal/adapters/recorderfleetjournal"
	"github.com/q9labs/chalk/apps/api/internal/mtls"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

type reconcileRunner interface {
	Reconcile(context.Context) (recorderfleet.Result, error)
}

func buildReconciler(config commandConfig) (*recorderfleet.Reconciler, error) {
	controlHTTP, err := newControllerHTTPClient(config)
	if err != nil {
		return nil, err
	}
	control, err := recorderfleetcontrol.New(recorderfleetcontrol.Config{
		BaseURL: config.ControlPlaneURL, HTTPClient: controlHTTP, Key: config.Fleet.Key,
	})
	if err != nil {
		return nil, fmt.Errorf("create recorder fleet control client: %w", err)
	}
	providerTransport := http.DefaultTransport.(*http.Transport).Clone()
	providerTransport.ForceAttemptHTTP2 = true
	config.Provider.HTTPClient = &http.Client{
		Transport: providerTransport,
		Timeout:   30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	provider, err := digitalocean.NewRecorderFleet(config.Provider)
	if err != nil {
		return nil, fmt.Errorf("create DigitalOcean recorder fleet: %w", err)
	}
	journal, err := recorderfleetjournal.New(config.JournalPath)
	if err != nil {
		return nil, fmt.Errorf("create recorder fleet journal: %w", err)
	}
	reconciler, err := recorderfleet.NewReconciler(config.Fleet, control, journal, provider, control, control)
	if err != nil {
		return nil, fmt.Errorf("create recorder fleet reconciler: %w", err)
	}
	return reconciler, nil
}

func newControllerHTTPClient(config commandConfig) (*http.Client, error) {
	tlsConfig, err := mtls.LoadClientConfig(config.ControllerCert, config.ControllerKey, config.ServerCA, config.ServerName)
	if err != nil {
		return nil, fmt.Errorf("load recorder fleet controller mTLS config: %w", err)
	}
	if len(tlsConfig.Certificates) != 1 || len(tlsConfig.Certificates[0].Certificate) == 0 {
		return nil, recorderfleet.ErrInvalidControllerIdentity
	}
	certificate := tlsConfig.Certificates[0].Leaf
	if certificate == nil {
		certificate, err = x509.ParseCertificate(tlsConfig.Certificates[0].Certificate[0])
		if err != nil {
			return nil, recorderfleet.ErrInvalidControllerIdentity
		}
	}
	verifier, err := recorderfleet.NewControllerVerifier(config.SPIFFETrustDomain, config.Fleet.Key.Environment)
	if err != nil {
		return nil, err
	}
	if _, err := verifier.VerifyCertificate(certificate); err != nil {
		return nil, fmt.Errorf("verify recorder fleet controller certificate: %w", err)
	}
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment, TLSClientConfig: tlsConfig, ForceAttemptHTTP2: true,
		MaxIdleConns: 8, MaxIdleConnsPerHost: 4, IdleConnTimeout: time.Minute,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}, nil
}

func runLoop(ctx context.Context, interval time.Duration, reconciler reconcileRunner, logger *slog.Logger) error {
	if ctx == nil || interval <= 0 || reconciler == nil || logger == nil {
		return recorderfleet.ErrInvalidConfig
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
			result, err := reconciler.Reconcile(ctx)
			if err != nil {
				logger.Error("recorder fleet reconciliation failed", "error", err)
			} else {
				logger.Info("recorder fleet reconciled",
					"action", result.Action,
					"provider_node_id", result.ProviderNodeID,
					"admission_open", result.Projection.AdmissionOpen,
					"ready_capacity", result.Projection.ReadyCapacity,
					"reason", result.Projection.Reason,
					"quarantined_nodes", len(result.Quarantined),
				)
			}
			if ctx.Err() != nil {
				return nil
			}
			timer.Reset(interval)
		}
	}
}
