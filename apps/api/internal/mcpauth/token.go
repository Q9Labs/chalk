package mcpauth

import (
	"context"
	"errors"
	"log/slog"
	"strings"
)

type TokenParams struct {
	GrantType    string
	ClientID     string
	Code         string
	RedirectURI  string
	CodeVerifier string
	RefreshToken string
	Resources    []string
}

func (s Service) Token(ctx context.Context, params TokenParams) (TokenResponse, *Error) {
	if _, err := s.repository.GetClient(ctx, params.ClientID); errors.Is(err, ErrClientNotFound) {
		return TokenResponse{}, oauthError(401, "invalid_client", "unknown client")
	} else if err != nil {
		return TokenResponse{}, oauthError(500, "server_error", "temporary failure")
	}
	for _, resource := range params.Resources {
		if resource != s.config.Resource() {
			return TokenResponse{}, oauthError(400, "invalid_target", "resource must be "+s.config.Resource())
		}
	}
	switch params.GrantType {
	case "authorization_code":
		return s.exchangeCode(ctx, params)
	case "refresh_token":
		return s.refresh(ctx, params)
	default:
		return TokenResponse{}, oauthError(400, "unsupported_grant_type", "use authorization_code or refresh_token")
	}
}

func (s Service) exchangeCode(ctx context.Context, params TokenParams) (TokenResponse, *Error) {
	if !strings.HasPrefix(params.Code, codePrefix) || len(params.Code) > 128 {
		return TokenResponse{}, oauthError(400, "invalid_grant", "authorization code is invalid")
	}
	response, tokens, err := s.mint(s.config.Resource())
	if err != nil {
		return TokenResponse{}, oauthError(500, "server_error", "temporary failure")
	}
	verify := func(redemption Redemption) error {
		if redemption.Grant.ClientID != params.ClientID || !redirectMatches(redemption, params.RedirectURI) || !verifyPKCE(params.CodeVerifier, redemption.CodeChallenge) {
			return ErrInvalidGrant
		}
		return nil
	}
	grant, err := s.repository.RedeemCode(ctx, hashSecret(params.Code), s.config.Now(), verify, tokens)
	if err != nil {
		return TokenResponse{}, s.grantError(ctx, err)
	}
	response.Scope = grant.Scope
	return response, nil
}

// redirectMatches applies RFC 6749 section 4.1.3: a redirect_uri that the
// authorization request carried must come back identical, and one it omitted
// may be omitted again or name the single registered URI.
func redirectMatches(redemption Redemption, redirectURI string) bool {
	if redirectURI == redemption.RedirectURI {
		return true
	}
	return !redemption.RedirectURISupplied && redirectURI == ""
}

func (s Service) refresh(ctx context.Context, params TokenParams) (TokenResponse, *Error) {
	if !strings.HasPrefix(params.RefreshToken, refreshTokenPrefix) || len(params.RefreshToken) > 128 {
		return TokenResponse{}, oauthError(400, "invalid_grant", "refresh token is invalid")
	}
	response, tokens, err := s.mint(s.config.Resource())
	if err != nil {
		return TokenResponse{}, oauthError(500, "server_error", "temporary failure")
	}
	grant, err := s.repository.RotateRefreshToken(ctx, hashSecret(params.RefreshToken), params.ClientID, s.config.Now(), tokens)
	if err != nil {
		return TokenResponse{}, s.grantError(ctx, err)
	}
	response.Scope = grant.Scope
	return response, nil
}

func (s Service) grantError(ctx context.Context, err error) *Error {
	switch {
	case errors.Is(err, ErrGrantReused):
		slog.WarnContext(ctx, "MCP OAuth credential reuse detected; grant revoked", "event", "mcp.oauth.reuse_detected")
		return oauthError(400, "invalid_grant", "credential was already used; the connection was revoked")
	case errors.Is(err, ErrInvalidGrant):
		return oauthError(400, "invalid_grant", "credential is invalid or expired")
	default:
		slog.ErrorContext(ctx, "MCP OAuth token exchange failed", "event", "mcp.oauth.token_failed", "error", err)
		return oauthError(500, "server_error", "temporary failure")
	}
}

func (s Service) mint(resource string) (TokenResponse, []NewToken, error) {
	access, accessHash, err := newSecret(AccessTokenPrefix)
	if err != nil {
		return TokenResponse{}, nil, err
	}
	refresh, refreshHash, err := newSecret(refreshTokenPrefix)
	if err != nil {
		return TokenResponse{}, nil, err
	}
	now := s.config.Now()
	return TokenResponse{AccessToken: access, RefreshToken: refresh, ExpiresIn: int64(s.config.AccessTokenTTL.Seconds())}, []NewToken{
		{Hash: accessHash, Kind: AccessToken, Resource: resource, ExpiresAt: now.Add(s.config.AccessTokenTTL)},
		{Hash: refreshHash, Kind: RefreshToken, Resource: resource, ExpiresAt: now.Add(s.config.RefreshTokenTTL)},
	}, nil
}
