package config

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

func loadServicePrincipal(systemToken string) (authentication.ServiceCredential, error) {
	id := strings.TrimSpace(envOrDefault(APIServiceID, ""))
	secrets := envList(APIServiceSecrets)
	scopes := envList(APIServiceScopes)
	credential := authentication.ServiceCredential{ID: id, Secrets: secrets}
	if id == "" && len(secrets) == 0 && len(scopes) == 0 {
		return credential, nil
	}
	if !tenants.ValidServiceID(id) || len(secrets) == 0 || len(scopes) == 0 {
		return authentication.ServiceCredential{}, fmt.Errorf("%s, %s and %s must all be configured", APIServiceID, APIServiceSecrets, APIServiceScopes)
	}
	for _, secret := range secrets {
		if !utf8.ValidString(secret) || utf8.RuneCountInString(secret) < 32 || strings.HasPrefix(secret, "chalk_sk_") || secret == systemToken || strings.ContainsAny(secret, " \t\r\n") {
			return authentication.ServiceCredential{}, fmt.Errorf("%s entries must be valid UTF-8 of at least 32 characters, contain no whitespace, and not overlap other credentials", APIServiceSecrets)
		}
	}
	for _, raw := range scopes {
		scope := authentication.Scope(raw)
		if !authentication.ValidScope(scope) {
			return authentication.ServiceCredential{}, fmt.Errorf("%s contains an invalid scope", APIServiceScopes)
		}
		credential.Scopes = append(credential.Scopes, scope)
	}
	return credential, nil
}
