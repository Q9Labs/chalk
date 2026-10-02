package recordernodebootstrap

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
)

const (
	digitalOceanMetadataURL = "http://169.254.169.254/metadata/v1/id"
)

func Bootstrap(ctx context.Context, config Config) error {
	logStep("metadata", 0, "started", 0, nil)
	providerID, err := ProviderID(ctx, digitalOceanMetadataURL)
	if err != nil {
		logStep("metadata", 0, "metadata_unavailable", httpStatus(err), err)
		return err
	}
	logStep("metadata", 0, "completed", 0, nil)
	logStep("identity", 0, "started", 0, nil)
	privateKey, csrPEM, err := LoadOrCreateIdentity(config.IdentityDirectory)
	if err != nil {
		logStep("identity", 0, "identity_unavailable", 0, err)
		return err
	}
	logStep("identity", 0, "completed", 0, nil)
	logStep("client", 0, "started", 0, nil)
	client, err := NewClient(config)
	if err != nil {
		logStep("client", 0, "client_unavailable", 0, err)
		return err
	}
	logStep("client", 0, "completed", 0, nil)
	claims := Claims{ProviderID: providerID, ReleaseID: config.ReleaseID, ImageDigest: config.ImageDigest, BootGeneration: config.BootGeneration}
	return retry(ctx, func(attemptContext context.Context, attempt int) error {
		response, bootstrapErr := client.bootstrap(attemptContext, claims, csrPEM, privateKey, attempt)
		if bootstrapErr != nil {
			if attempt >= 2 {
				diagnostic := diagnosticFor(bootstrapErr, attempt)
				reportContext, cancel := context.WithTimeout(attemptContext, 5*time.Second)
				reportErr := client.reportDiagnostic(reportContext, claims, csrPEM, privateKey, diagnostic)
				cancel()
				if reportErr != nil {
					logStep("diagnostic", attempt, "report_failed", httpStatus(reportErr), reportErr)
				} else {
					logStep("diagnostic", attempt, "reported", http.StatusNoContent, nil)
				}
			}
			return bootstrapErr
		}
		logStep("install", attempt, "started", 0, nil)
		if err := InstallBootstrapResponse(config, claims, csrPEM, response, time.Now()); err != nil {
			logStep("install", attempt, "install_failed", 0, err)
			return err
		}
		logStep("install", attempt, "completed", 0, nil)
		return nil
	})
}

func Renew(ctx context.Context, config Config) error {
	endpoint, renewAt, err := RenewalState(config.IdentityDirectory)
	if err != nil {
		logStep("renewal_state", 0, "renewal_state_unavailable", 0, err)
		return err
	}
	if time.Now().Before(renewAt) {
		return nil
	}
	_, csrPEM, err := LoadOrCreateIdentity(config.IdentityDirectory)
	if err != nil {
		logStep("identity", 0, "identity_unavailable", 0, err)
		return err
	}
	client, err := NewClient(config)
	if err != nil {
		logStep("client", 0, "client_unavailable", 0, err)
		return err
	}
	certificateFile, privateKeyFile := IdentityPaths(config.IdentityDirectory)
	request := recorderbootstrapprotocol.RenewRequest{SchemaVersion: recorderbootstrapprotocol.RenewSchemaVersion, CSRPEM: csrPEM}
	return retry(ctx, func(attemptContext context.Context, attempt int) error {
		logStep("renew", attempt, "started", 0, nil)
		response, renewErr := client.Renew(attemptContext, endpoint, certificateFile, privateKeyFile, request)
		if renewErr != nil {
			logStep("renew", attempt, reasonCode(renewErr, "renew_unavailable"), httpStatus(renewErr), renewErr)
			return renewErr
		}
		if err := InstallRenewResponse(config, csrPEM, response, time.Now()); err != nil {
			logStep("install", attempt, "install_failed", 0, err)
			return err
		}
		logStep("renew", attempt, "completed", 0, nil)
		return nil
	})
}

func retry(ctx context.Context, operation func(context.Context, int) error) error {
	delay := time.Second
	attempt := 0
	for {
		attempt++
		err := operation(ctx, attempt)
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrBootstrapUnavailable) {
			return err
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			logStep("bootstrap", attempt, "retry_deadline_exceeded", httpStatus(err), err)
			return fmt.Errorf("bootstrap.retry_deadline_exceeded after %d attempts: %w: %v", attempt, ctx.Err(), err)
		case <-timer.C:
		}
		if delay < 15*time.Second {
			delay *= 2
			if delay > 15*time.Second {
				delay = 15 * time.Second
			}
		}
	}
}
