package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/digitalocean"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	issuer "github.com/q9labs/chalk/apps/api/internal/recorderfleetissuer"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func run(ctx context.Context, config commandConfig, logger *slog.Logger) error {
	serverTLS, err := loadServerTLS(config)
	if err != nil {
		return err
	}
	workerCAPEM, err := os.ReadFile(config.WorkerCACertFile)
	if err != nil {
		return fmt.Errorf("read worker CA certificate: %w", err)
	}
	workerCAKeyPEM, err := os.ReadFile(config.WorkerCAKeyFile)
	if err != nil {
		return fmt.Errorf("read worker CA key: %w", err)
	}
	controlPlaneCAPEM, err := os.ReadFile(config.ControlPlaneServerCAFile)
	if err != nil {
		return fmt.Errorf("read control plane server CA: %w", err)
	}
	certificateAuthority, err := issuer.NewCertificateAuthority(workerCAPEM, workerCAKeyPEM, config.TrustDomain)
	if err != nil {
		return fmt.Errorf("load worker certificate authority: %w", err)
	}
	state, err := issuer.OpenStore(config.StatePath)
	if err != nil {
		return err
	}
	token, err := readSecretFile(config.DigitalOceanTokenFile)
	if err != nil {
		return err
	}
	providerTransport := http.DefaultTransport.(*http.Transport).Clone()
	providerTransport.ForceAttemptHTTP2 = true
	providerHTTP := &http.Client{
		Transport: providerTransport, Timeout: 15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	providers := make(roleInventories, 2)
	for _, role := range []workeridentity.Role{workeridentity.RoleCapture, workeridentity.RoleRender} {
		provider, err := digitalocean.NewRecorderFleet(digitalocean.RecorderFleetConfig{
			Token: token, BaseURL: config.DigitalOceanBaseURL, HTTPClient: providerHTTP,
			Environment: config.Environment, Role: role, OwnerTag: config.OwnerTag,
			GPU: role == workeridentity.RoleRender && config.RenderGPU,
		})
		if err != nil {
			return fmt.Errorf("create DigitalOcean %s inventory client: %w", role, err)
		}
		providers[role] = provider
	}
	service, err := issuer.New(issuer.Config{
		Environment: config.Environment, OwnerTag: config.OwnerTag, Store: state, Inventory: providers,
		CertificateAuthority: certificateAuthority, PublicBaseURL: config.PublicBaseURL,
		ControlPlaneURL: config.ControlPlaneURL, ControlPlaneServerName: config.ControlPlaneServerName,
		ControlPlaneServerCAPEM: string(controlPlaneCAPEM), ChallengeTTL: config.ChallengeTTL,
		CertificateLifetime: config.CertificateLifetime, RenewalLead: config.RenewalLead,
	})
	if err != nil {
		return err
	}
	controllerVerifier, err := recorderfleet.NewControllerVerifier(config.TrustDomain, config.Environment)
	if err != nil {
		return err
	}
	workerVerifier, err := workeridentity.NewVerifier(config.TrustDomain, config.Environment)
	if err != nil {
		return err
	}
	handler, err := issuer.NewHTTPHandler(service, controllerVerifier, workerVerifier, logger)
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr: config.ListenAddress, Handler: handler, TLSConfig: serverTLS,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: time.Minute,
	}
	serveErrors := make(chan error, 1)
	go func() {
		logger.Info("recorder fleet issuer listening", "address", config.ListenAddress)
		serveErrors <- server.ListenAndServeTLS("", "")
	}()
	select {
	case err := <-serveErrors:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve recorder fleet issuer: %w", err)
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			return fmt.Errorf("shut down recorder fleet issuer: %w", err)
		}
		return nil
	}
}

type roleInventories map[workeridentity.Role]*digitalocean.RecorderFleet

func (inventories roleInventories) InspectNode(ctx context.Context, key recorderfleet.PoolKey, providerID string) (recorderfleet.Node, netip.Addr, error) {
	inventory := inventories[key.Role]
	if inventory == nil {
		return recorderfleet.Node{}, netip.Addr{}, recorderfleet.ErrRoleFence
	}
	return inventory.InspectNode(ctx, key, providerID)
}

func loadServerTLS(config commandConfig) (*tls.Config, error) {
	certificate, err := tls.LoadX509KeyPair(config.ServerCertFile, config.ServerKeyFile)
	if err != nil {
		return nil, fmt.Errorf("load issuer server certificate: %w", err)
	}
	clientCAs := x509.NewCertPool()
	for _, path := range []string{config.ControllerCAFile, config.WorkerCACertFile} {
		encoded, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read issuer client CA: %w", err)
		}
		if !clientCAs.AppendCertsFromPEM(encoded) {
			return nil, issuer.ErrInvalidConfig
		}
	}
	return &tls.Config{
		Certificates: []tls.Certificate{certificate}, ClientAuth: tls.VerifyClientCertIfGiven,
		ClientCAs: clientCAs, MinVersion: tls.VersionTLS13,
	}, nil
}
