package config

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

func loadServicePrincipals(systemToken string) ([]authentication.ServiceCredential, string, error) {
	dashboard, err := loadServicePrincipal(systemToken)
	if err != nil {
		return nil, "", err
	}
	var credentials []authentication.ServiceCredential
	if dashboard.ID != "" {
		credentials = append(credentials, dashboard)
	}
	raw := strings.TrimSpace(envOrDefault(APIServicePrincipals, ""))
	if raw == "" {
		return credentials, dashboard.ID, nil
	}

	var additional []authentication.ServiceCredential
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if !utf8.ValidString(raw) || decoder.Decode(&additional) != nil || additional == nil || decoder.Decode(new(json.RawMessage)) != io.EOF {
		return nil, "", fmt.Errorf("%s must be a JSON array of objects with id, secrets and scopes", APIServicePrincipals)
	}
	ids := make(map[string]bool)
	secretOwners := make(map[string]string)
	for _, credential := range credentials {
		ids[credential.ID] = true
		for _, secret := range credential.Secrets {
			secretOwners[secret] = credential.ID
		}
	}
	for i, credential := range additional {
		if err := validateServiceCredential(credential, systemToken, ids, secretOwners); err != nil {
			return nil, "", fmt.Errorf("%s entry %d: %w", APIServicePrincipals, i+1, err)
		}
	}
	return append(credentials, additional...), dashboard.ID, nil
}

func validateServiceCredential(credential authentication.ServiceCredential, systemToken string, ids map[string]bool, secretOwners map[string]string) error {
	if !tenants.ValidServiceID(credential.ID) || len(credential.Secrets) == 0 || len(credential.Scopes) == 0 {
		return fmt.Errorf("a valid id and nonempty secrets and scopes are required")
	}
	if ids[credential.ID] {
		return fmt.Errorf("service id must be unique")
	}
	ids[credential.ID] = true
	for _, secret := range credential.Secrets {
		if !validServiceSecret(secret, systemToken) || (secretOwners[secret] != "" && secretOwners[secret] != credential.ID) {
			return fmt.Errorf("secrets must be valid UTF-8 of at least 32 characters, contain no whitespace, and not overlap other credentials")
		}
		secretOwners[secret] = credential.ID
	}
	for _, scope := range credential.Scopes {
		if !authentication.ValidScope(scope) {
			return fmt.Errorf("invalid scope")
		}
	}
	return nil
}

func validServiceSecret(secret, systemToken string) bool {
	return utf8.ValidString(secret) && utf8.RuneCountInString(secret) >= 32 && !apikeys.LooksLikeRawKey(secret) && secret != systemToken && !strings.ContainsAny(secret, " \t\r\n")
}

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
		if !validServiceSecret(secret, systemToken) {
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
