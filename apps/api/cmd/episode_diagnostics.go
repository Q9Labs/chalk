package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/auditlogs"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type episodeDiagnosticsComponents struct {
	appendPool        *pgxpool.Pool
	queryPool         *pgxpool.Pool
	service           episodediagnostics.Service
	runtime           *episodediagnostics.Runtime
	issuer            accessgrants.DiagnosticsIssuer
	verifier          accessgrants.DiagnosticsVerifier
	serviceIssuer     accessgrants.DiagnosticsServiceIssuer
	serviceVerifier   httpapi.EpisodeDiagnosticsServiceVerifier
	servicePrincipals map[accessgrants.DiagnosticsServiceSource]accessgrants.DiagnosticsServiceSubject
	operatorVerifier  httpapi.EpisodeDiagnosticsOperatorVerifier
	mode              string
	environment       episodediagnostics.Environment
	producerToken     string
	operatorToken     string
}

func newEpisodeDiagnosticsComponents(ctx context.Context, cfg config.Config, audits auditlogs.Service, logger *slog.Logger) (*episodeDiagnosticsComponents, error) {
	diagnosticsConfig := cfg.EpisodeDiagnostics
	if diagnosticsConfig.Mode == config.EpisodeDiagnosticsModeOff {
		return nil, nil
	}
	if len(cfg.SyncToken.PrivateKey) == 0 || len(cfg.SyncToken.VerificationKeys) == 0 {
		return nil, errors.New("episode diagnostics requires Sync signing and verification keys")
	}

	appendPool, err := postgres.Open(ctx, diagnosticsConfig.AppendDatabase)
	if err != nil {
		return nil, fmt.Errorf("open Episode Diagnostics append postgres pool: %w", err)
	}
	queryPool, err := postgres.Open(ctx, diagnosticsConfig.QueryDatabase)
	if err != nil {
		appendPool.Close()
		return nil, fmt.Errorf("open Episode Diagnostics query postgres pool: %w", err)
	}

	environment := episodediagnostics.Environment(diagnosticsConfig.Environment)
	issuer, err := accessgrants.NewDiagnosticsIssuer(accessgrants.DiagnosticsIssuerConfig{
		Issuer:      cfg.SyncToken.Issuer,
		KeyID:       cfg.SyncToken.KeyID,
		PrivateKey:  cfg.SyncToken.PrivateKey,
		Environment: string(environment),
	})
	if err != nil {
		queryPool.Close()
		appendPool.Close()
		return nil, fmt.Errorf("configure Episode Diagnostics participant issuer: %w", err)
	}
	verifier, err := accessgrants.NewDiagnosticsVerifier(accessgrants.DiagnosticsVerifierConfig{
		Issuer:           cfg.SyncToken.Issuer,
		VerificationKeys: cfg.SyncToken.VerificationKeys,
		Environment:      string(environment),
	})
	if err != nil {
		queryPool.Close()
		appendPool.Close()
		return nil, fmt.Errorf("configure Episode Diagnostics participant verifier: %w", err)
	}
	var serviceIssuer accessgrants.DiagnosticsServiceIssuer
	var serviceVerifier httpapi.EpisodeDiagnosticsServiceVerifier
	if diagnosticsConfig.Mode == config.EpisodeDiagnosticsModeHosted {
		serviceIssuer, err = accessgrants.NewDiagnosticsServiceIssuer(accessgrants.DiagnosticsServiceIssuerConfig{
			Issuer: diagnosticsConfig.ServiceToken.Issuer, KeyID: diagnosticsConfig.ServiceToken.KeyID,
			PrivateKey: diagnosticsConfig.ServiceToken.PrivateKey, Environment: string(environment),
		})
		if err != nil {
			queryPool.Close()
			appendPool.Close()
			return nil, fmt.Errorf("configure Episode Diagnostics service issuer: %w", err)
		}
		configuredVerifier, verifierErr := accessgrants.NewDiagnosticsServiceVerifier(accessgrants.DiagnosticsServiceVerifierConfig{
			Issuer: diagnosticsConfig.ServiceToken.Issuer, VerificationKeys: diagnosticsConfig.ServiceToken.VerificationKeys, Environment: string(environment),
		})
		if verifierErr != nil {
			queryPool.Close()
			appendPool.Close()
			return nil, fmt.Errorf("configure Episode Diagnostics service verifier: %w", verifierErr)
		}
		serviceVerifier = configuredVerifier
	}
	var operatorVerifier httpapi.EpisodeDiagnosticsOperatorVerifier
	if diagnosticsConfig.Mode == config.EpisodeDiagnosticsModeHosted {
		verifier, verifierErr := accessgrants.NewDiagnosticsOperatorVerifier(accessgrants.DiagnosticsOperatorVerifierConfig{
			Issuer:      diagnosticsConfig.OperatorIssuer,
			Audience:    diagnosticsConfig.OperatorAudience,
			JWKS:        diagnosticsConfig.OperatorJWKS,
			Environment: string(environment),
		})
		if verifierErr != nil {
			queryPool.Close()
			appendPool.Close()
			return nil, fmt.Errorf("configure Episode Diagnostics operator verifier: %w", verifierErr)
		}
		operatorVerifier = verifier
	}

	repository := postgres.NewEpisodeDiagnosticsRepository(appendPool, queryPool)
	if err := repository.EnsureDiagnosticEnvironmentOwnership(ctx, environment); err != nil {
		queryPool.Close()
		appendPool.Close()
		return nil, fmt.Errorf("claim Episode Diagnostics database environment: %w", err)
	}
	telemetry := observability.NewEpisodeDiagnosticTelemetry(logger)
	service := episodediagnostics.NewService(
		repository,
		environment,
		diagnosticsConfig.HMACKey,
		episodediagnostics.NewAuditLogWriter(audits),
		telemetry,
	)
	workerID, err := utilities.NewID()
	if err != nil {
		queryPool.Close()
		appendPool.Close()
		return nil, fmt.Errorf("create Episode Diagnostics worker id: %w", err)
	}
	servicePrincipals := make(map[accessgrants.DiagnosticsServiceSource]accessgrants.DiagnosticsServiceSubject, 3)
	if diagnosticsConfig.Mode == config.EpisodeDiagnosticsModeHosted {
		for source, serviceName := range map[accessgrants.DiagnosticsServiceSource]string{
			accessgrants.DiagnosticsServiceSourceAPI:      cfg.Observability.Service,
			accessgrants.DiagnosticsServiceSourceProvider: cfg.Observability.Service + "-provider",
			accessgrants.DiagnosticsServiceSourceWorker:   cfg.Observability.Service + "-worker",
		} {
			principal, principalErr := accessgrants.NewDiagnosticsServicePrincipal(source, serviceName, workerID.String(), 1, string(environment))
			if principalErr != nil {
				queryPool.Close()
				appendPool.Close()
				return nil, fmt.Errorf("configure Episode Diagnostics %s principal: %w", source, principalErr)
			}
			credential, issueErr := serviceIssuer.Issue(ctx, principal)
			if issueErr != nil {
				queryPool.Close()
				appendPool.Close()
				return nil, fmt.Errorf("issue Episode Diagnostics %s principal: %w", source, issueErr)
			}
			verified, verifyErr := serviceVerifier.Verify(ctx, credential.Token)
			if verifyErr != nil {
				queryPool.Close()
				appendPool.Close()
				return nil, fmt.Errorf("verify Episode Diagnostics %s principal: %w", source, verifyErr)
			}
			if verified != principal {
				queryPool.Close()
				appendPool.Close()
				return nil, fmt.Errorf("verify Episode Diagnostics %s principal: subject mismatch", source)
			}
			servicePrincipals[source] = principal
		}
	}
	runtime := episodediagnostics.NewRuntime(service, repository, environment, episodediagnostics.RuntimeConfig{
		ProjectorInterval: diagnosticsConfig.ProjectorInterval,
		ReconcileInterval: diagnosticsConfig.ReconcileInterval,
		DeadlineInterval:  diagnosticsConfig.DeadlineInterval,
		RetentionInterval: diagnosticsConfig.RetentionInterval,
		ProjectorBatch:    int(diagnosticsConfig.ProjectorBatch),
		ReconcileBatch:    int(diagnosticsConfig.ReconcileBatch),
		DeadlineBatch:     int(diagnosticsConfig.DeadlineBatch),
		RetentionBatch:    int(diagnosticsConfig.RetentionBatch),
		WorkerID:          workerID.String(),
	}, logger)
	return &episodeDiagnosticsComponents{
		appendPool:        appendPool,
		queryPool:         queryPool,
		service:           service,
		runtime:           runtime,
		issuer:            issuer,
		verifier:          verifier,
		serviceIssuer:     serviceIssuer,
		serviceVerifier:   serviceVerifier,
		servicePrincipals: servicePrincipals,
		operatorVerifier:  operatorVerifier,
		mode:              diagnosticsConfig.Mode,
		environment:       environment,
		producerToken:     diagnosticsConfig.ProducerToken,
		operatorToken:     diagnosticsConfig.OperatorToken,
	}, nil
}

func (c *episodeDiagnosticsComponents) IssueServiceCredential(ctx context.Context, source accessgrants.DiagnosticsServiceSource) (accessgrants.DiagnosticsServiceCredential, error) {
	if c == nil || c.mode != config.EpisodeDiagnosticsModeHosted {
		return accessgrants.DiagnosticsServiceCredential{}, accessgrants.ErrInvalidDiagnosticsServiceConfig
	}
	principal, ok := c.servicePrincipals[source]
	if !ok {
		return accessgrants.DiagnosticsServiceCredential{}, accessgrants.ErrInvalidDiagnosticsServiceSource
	}
	return c.serviceIssuer.Issue(ctx, principal)
}

func (c *episodeDiagnosticsComponents) Close() {
	if c == nil {
		return
	}
	if c.queryPool != nil {
		c.queryPool.Close()
	}
	if c.appendPool != nil {
		c.appendPool.Close()
	}
}

func (c *episodeDiagnosticsComponents) HTTPOptions() httpapi.EpisodeDiagnosticsHTTPOptions {
	if c == nil {
		return httpapi.EpisodeDiagnosticsHTTPOptions{}
	}
	return httpapi.EpisodeDiagnosticsHTTPOptions{
		Mode:                c.mode,
		Environment:         c.environment,
		Service:             c.service,
		ProducerToken:       c.producerToken,
		OperatorToken:       c.operatorToken,
		OperatorVerifier:    c.operatorVerifier,
		ParticipantVerifier: c.verifier,
		ServiceVerifier:     c.serviceVerifier,
	}
}
