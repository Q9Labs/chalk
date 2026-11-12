package main

import (
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
)

// buildParticipantAuth wires the Sync token and participant media credentials.
// Without a Sync token key the issuers stay unset and routes needing them answer 503.
func (w *wiring) buildParticipantAuth() error {
	cfg := w.cfg
	participantActiveAuthorizer := accessgrants.NewActiveAuthorizer(w.episodeRepository)
	w.opts.ParticipantMediaActive = participantActiveAuthorizer
	w.opts.ParticipantGeneration = participantActiveAuthorizer
	if len(cfg.SyncToken.PrivateKey) == 0 {
		return nil
	}
	service, err := synctokens.NewService(synctokens.Config{
		Issuer: cfg.SyncToken.Issuer, Audience: cfg.SyncToken.Audience,
		KeyID: cfg.SyncToken.KeyID, PrivateKey: cfg.SyncToken.PrivateKey,
	})
	if err != nil {
		return fmt.Errorf("configure sync token issuer: %w", err)
	}
	broker := synctokens.NewBroker(w.episodeRepository, service)
	w.opts.SyncTokens = broker
	w.opts.SyncTokenRefresh = broker
	w.syncParticipantVerifier, err = synctokens.NewVerifier(synctokens.VerifierConfig{
		Issuer: cfg.SyncToken.Issuer, Audience: cfg.SyncToken.Audience,
		VerificationKeys: cfg.SyncToken.VerificationKeys,
	})
	if err != nil {
		return fmt.Errorf("configure Sync participant verifier: %w", err)
	}
	w.syncVerifierConfigured = true
	mediaIssuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{
		Issuer: cfg.SyncToken.Issuer, KeyID: cfg.SyncToken.KeyID, PrivateKey: cfg.SyncToken.PrivateKey,
	})
	if err != nil {
		return fmt.Errorf("configure participant media issuer: %w", err)
	}
	mediaVerifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{
		Issuer: cfg.SyncToken.Issuer, VerificationKeys: cfg.SyncToken.VerificationKeys,
	})
	if err != nil {
		return fmt.Errorf("configure participant media verifier: %w", err)
	}
	w.opts.ParticipantMediaIssuer = observability.InstrumentAccessGrantIssuer(mediaIssuer, w.obs.launch)
	instrumentedMediaVerifier := observability.InstrumentParticipantMediaVerifier(mediaVerifier, w.obs.launch)
	w.opts.ParticipantMediaVerify = instrumentedMediaVerifier
	w.participantMediaRecovery = instrumentedMediaVerifier
	return nil
}
