package main

import (
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
)

// participantCredentials issue and verify what a Participant holds: the Sync token and the media and
// telemetry credentials. Without a Sync token key every field stays nil, and the routes that need one answer 503.
type participantCredentials struct {
	syncTokens             httpapi.SyncTokenIssuer
	syncRefresh            httpapi.SyncTokenRefreshIssuer
	mediaIssuer            httpapi.ParticipantMediaIssuer
	mediaVerifier          httpapi.ParticipantMediaVerifier
	telemetryVerifier      httpapi.TelemetryVerifier
	mediaRecovery          publicinviteapp.MediaProofRecoveryVerifier
	syncVerifier           synctokens.Verifier
	syncVerifierConfigured bool
}

func newParticipantCredentials(cfg config.SyncTokenConfig, subjects synctokens.SubjectRepository, launchTelemetry *observability.LaunchTelemetry) (participantCredentials, error) {
	var credentials participantCredentials
	if len(cfg.PrivateKey) == 0 {
		return credentials, nil
	}
	service, err := synctokens.NewService(synctokens.Config{
		Issuer: cfg.Issuer, Audience: cfg.Audience,
		KeyID: cfg.KeyID, PrivateKey: cfg.PrivateKey,
	})
	if err != nil {
		return credentials, fmt.Errorf("configure sync token issuer: %w", err)
	}
	broker := synctokens.NewBroker(subjects, service)
	credentials.syncTokens = broker
	credentials.syncRefresh = broker
	credentials.syncVerifier, err = synctokens.NewVerifier(synctokens.VerifierConfig{
		Issuer: cfg.Issuer, Audience: cfg.Audience,
		VerificationKeys: cfg.VerificationKeys,
	})
	if err != nil {
		return credentials, fmt.Errorf("configure Sync participant verifier: %w", err)
	}
	credentials.syncVerifierConfigured = true
	mediaIssuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{
		Issuer: cfg.Issuer, KeyID: cfg.KeyID, PrivateKey: cfg.PrivateKey,
	})
	if err != nil {
		return credentials, fmt.Errorf("configure participant media issuer: %w", err)
	}
	mediaVerifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{
		Issuer: cfg.Issuer, VerificationKeys: cfg.VerificationKeys,
	})
	if err != nil {
		return credentials, fmt.Errorf("configure participant media verifier: %w", err)
	}
	credentials.mediaIssuer = observability.InstrumentAccessGrantIssuer(mediaIssuer, launchTelemetry)
	instrumentedMediaVerifier := observability.InstrumentParticipantMediaVerifier(mediaVerifier, launchTelemetry)
	credentials.mediaVerifier = instrumentedMediaVerifier
	credentials.mediaRecovery = instrumentedMediaVerifier
	credentials.telemetryVerifier = mediaVerifier
	return credentials, nil
}
