package recordernodebootstrap

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
)

const (
	digitalOceanMetadataURL = "http://169.254.169.254/metadata/v1/id"
)

func Bootstrap(ctx context.Context, config Config) error {
	providerID, err := ProviderID(ctx, digitalOceanMetadataURL)
	if err != nil {
		return err
	}
	privateKey, csrPEM, err := LoadOrCreateIdentity(config.IdentityDirectory)
	if err != nil {
		return err
	}
	client, err := NewClient(config)
	if err != nil {
		return err
	}
	claims := Claims{ProviderID: providerID, ReleaseID: config.ReleaseID, ImageDigest: config.ImageDigest, BootGeneration: config.BootGeneration}
	return retry(ctx, func(attemptContext context.Context) error {
		response, bootstrapErr := client.Bootstrap(attemptContext, claims, csrPEM, privateKey)
		if bootstrapErr != nil {
			return bootstrapErr
		}
		return InstallBootstrapResponse(config, claims, csrPEM, response, time.Now())
	})
}

func Renew(ctx context.Context, config Config) error {
	endpoint, renewAt, err := RenewalState(config.IdentityDirectory)
	if err != nil {
		return err
	}
	if time.Now().Before(renewAt) {
		return nil
	}
	_, csrPEM, err := LoadOrCreateIdentity(config.IdentityDirectory)
	if err != nil {
		return err
	}
	client, err := NewClient(config)
	if err != nil {
		return err
	}
	certificateFile, privateKeyFile := IdentityPaths(config.IdentityDirectory)
	request := recorderbootstrapprotocol.RenewRequest{SchemaVersion: recorderbootstrapprotocol.RenewSchemaVersion, CSRPEM: csrPEM}
	return retry(ctx, func(attemptContext context.Context) error {
		response, renewErr := client.Renew(attemptContext, endpoint, certificateFile, privateKeyFile, request)
		if renewErr != nil {
			return renewErr
		}
		return InstallRenewResponse(config, csrPEM, response, time.Now())
	})
}

func retry(ctx context.Context, operation func(context.Context) error) error {
	delay := time.Second
	for {
		err := operation(ctx)
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
			return fmt.Errorf("%w: %v", ctx.Err(), err)
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
