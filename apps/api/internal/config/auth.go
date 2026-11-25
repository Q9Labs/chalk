package config

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

const (
	APIAddress            = "CHALK_API_ADDR"
	APICORSAllowedOrigins = "CHALK_API_CORS_ALLOWED_ORIGINS"
	APIRateLimits         = "CHALK_API_RATE_LIMITS"
	APITrustedProxyCIDRs  = "CHALK_API_TRUSTED_PROXY_CIDRS"
	APILocalSystemToken   = "CHALK_API_LOCAL_SYSTEM_TOKEN"
	APIServiceID          = "CHALK_API_SERVICE_ID"
	APIServiceSecrets     = "CHALK_API_SERVICE_SECRETS"
	APIServiceScopes      = "CHALK_API_SERVICE_SCOPES"
	APIServicePrincipals  = "CHALK_API_SERVICE_PRINCIPALS"

	OAuthIssuer            = "CHALK_OAUTH_ISSUER"
	OAuthConsentURL        = "CHALK_OAUTH_CONSENT_URL"
	OAuthExtraRedirectURIs = "CHALK_OAUTH_EXTRA_REDIRECT_URIS"
	DefaultAPIAddress      = ":8080"
)

type APIConfig struct {
	DisableAuthenticatedRateLimits bool
	Address                        string
	CORSAllowedOrigins             []string
	LocalSystemToken               string
	ServicePrincipals              []authentication.ServiceCredential
	OAuth                          OAuthConfig

	TrustedProxyCIDRs []string
}

// OAuthConfig turns on OAuth for the hosted MCP server. A zero Issuer keeps it off.
type OAuthConfig struct {
	Issuer            string
	ConsentURL        string
	ExtraRedirectURIs []string
}

func loadOAuthConfig(environment string) (OAuthConfig, error) {
	issuer := strings.TrimSpace(envOrDefault(OAuthIssuer, ""))
	consent := strings.TrimSpace(envOrDefault(OAuthConsentURL, ""))
	extra := envList(OAuthExtraRedirectURIs)
	if issuer == "" {
		if consent != "" || len(extra) > 0 {
			return OAuthConfig{}, fmt.Errorf("%s is required when other OAuth settings are set", OAuthIssuer)
		}
		return OAuthConfig{}, nil
	}
	if err := validateOAuthURL(environment, OAuthIssuer, issuer, false); err != nil {
		return OAuthConfig{}, err
	}
	if err := validateOAuthURL(environment, OAuthConsentURL, consent, true); err != nil {
		return OAuthConfig{}, err
	}
	return OAuthConfig{Issuer: issuer, ConsentURL: consent, ExtraRedirectURIs: extra}, nil
}

// validateOAuthURL requires an absolute https URL, with no credentials or
// fragment. The issuer is an origin; the consent URL may carry a path.
func validateOAuthURL(environment, name, raw string, allowPath bool) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" {
		return fmt.Errorf("%s must be an absolute URL without credentials, query or fragment", name)
	}
	if !allowPath && (parsed.Path != "" || strings.HasSuffix(raw, "/")) {
		return fmt.Errorf("%s must be an origin without a path", name)
	}
	if parsed.Scheme != "https" && !(environment == DefaultEnvironment && parsed.Scheme == "http") {
		return fmt.Errorf("%s must use https outside local environments", name)
	}
	return nil
}
