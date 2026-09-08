package main

import (
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/adapters/recorderfleetissuer"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleetauthority"
)

type recorderFleetComponents struct {
	service            recorderfleetauthority.Service
	controllerVerifier httpapi.RecorderFleetControllerVerifier
	workerVerifier     httpapi.RecorderWorkerVerifier
}

func newRecorderFleetComponents(cfg config.Config, queries sqlc.Querier, base httpapi.RecorderWorkerVerifier) (recorderFleetComponents, error) {
	var issuer recorderfleet.BootstrapAuthority = recorderfleetissuer.UnavailableAuthority{}
	if cfg.RecorderFleetIssuer.URL != "" {
		configured, err := recorderfleetissuer.New(recorderfleetissuer.Config{
			BaseURL:        cfg.RecorderFleetIssuer.URL,
			ClientCertFile: cfg.RecorderFleetIssuer.ClientCertFile,
			ClientKeyFile:  cfg.RecorderFleetIssuer.ClientKeyFile,
			ServerCAFile:   cfg.RecorderFleetIssuer.ServerCAFile,
			ServerName:     cfg.RecorderFleetIssuer.ServerName,
		})
		if err != nil {
			return recorderFleetComponents{}, fmt.Errorf("configure recorder bootstrap issuer: %w", err)
		}
		issuer = configured
	}
	service, err := recorderfleetauthority.NewService(cfg.Observability.Environment, postgres.NewRecordingFleetAuthorityRepository(queries), issuer)
	if err != nil {
		return recorderFleetComponents{}, fmt.Errorf("configure recorder fleet authority: %w", err)
	}
	controllerVerifier, err := recorderfleet.NewControllerVerifier(cfg.ProviderBridge.SPIFFETrustDomain, cfg.Observability.Environment)
	if err != nil {
		return recorderFleetComponents{}, fmt.Errorf("configure recorder fleet controller identity: %w", err)
	}
	workerVerifier, err := recorderfleetauthority.NewBoundWorkerVerifier(base, service)
	if err != nil {
		return recorderFleetComponents{}, fmt.Errorf("configure recorder worker node authority: %w", err)
	}
	return recorderFleetComponents{service: service, controllerVerifier: controllerVerifier, workerVerifier: workerVerifier}, nil
}
