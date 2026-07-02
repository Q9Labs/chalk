package google

import (
	"context"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/idtoken"
)

type Config struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string
}

type Provider struct {
	clientID string
	config   oauth2.Config
}

func NewProvider(cfg Config) (Provider, error) {
	if cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.RedirectURL == "" {
		return Provider{}, authentication.ErrOAuthNotConfigured
	}

	return Provider{
		clientID: cfg.ClientID,
		config: oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			RedirectURL:  cfg.RedirectURL,
			Scopes:       []string{"openid", "email", "profile"},
			Endpoint:     google.Endpoint,
		},
	}, nil
}

func (p Provider) NewVerifier() string {
	return oauth2.GenerateVerifier()
}

func (p Provider) AuthCodeURL(state string, verifier string) string {
	return p.config.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier))
}

func (p Provider) Authenticate(ctx context.Context, code string, verifier string) (authentication.GoogleIdentity, error) {
	token, err := p.config.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return authentication.GoogleIdentity{}, fmt.Errorf("exchange google code: %w", err)
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return authentication.GoogleIdentity{}, errors.New("google id token missing")
	}

	payload, err := idtoken.Validate(ctx, rawIDToken, p.clientID)
	if err != nil {
		return authentication.GoogleIdentity{}, fmt.Errorf("validate google id token: %w", err)
	}

	return googleIdentityFromPayload(payload)
}

func googleIdentityFromPayload(payload *idtoken.Payload) (authentication.GoogleIdentity, error) {
	email, _ := payload.Claims["email"].(string)
	name, _ := payload.Claims["name"].(string)
	emailVerified, _ := payload.Claims["email_verified"].(bool)
	if !emailVerified {
		return authentication.GoogleIdentity{}, authentication.ErrOAuthEmailNotVerified
	}

	return authentication.GoogleIdentity{
		Subject: payload.Subject,
		Email:   email,
		Name:    name,
	}, nil
}
