package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

type servicePrincipalConfig struct {
	ID        string   `json:"id"`
	Secrets   []string `json:"secrets"`
	Scopes    []string `json:"scopes"`
	Dashboard bool     `json:"dashboard"`
}

func loadServicePrincipals(systemToken string) ([]authentication.ServiceCredential, error) {
	var credentials []authentication.ServiceCredential
	legacy, legacyConfigured, err := loadLegacyServicePrincipal(systemToken)
	if err != nil {
		return nil, err
	}
	if legacyConfigured {
		credentials = append(credentials, legacy)
	}

	encoded := strings.TrimSpace(envOrDefault(APIServicePrincipals, ""))
	if encoded != "" {
		entries, err := parseServicePrincipalEntries(encoded)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			credential, err := validateServicePrincipal(entry.ID, entry.Secrets, entry.Scopes, systemToken, APIServicePrincipals)
			if err != nil {
				return nil, err
			}
			credential.Dashboard = entry.Dashboard
			credentials = append(credentials, credential)
		}
	}
	if err := validateServicePrincipalSet(credentials); err != nil {
		return nil, err
	}
	return credentials, nil
}

func loadLegacyServicePrincipal(systemToken string) (authentication.ServiceCredential, bool, error) {
	id := strings.TrimSpace(envOrDefault(APIServiceID, ""))
	secrets := envList(APIServiceSecrets)
	scopes := envList(APIServiceScopes)
	if id == "" && len(secrets) == 0 && len(scopes) == 0 {
		return authentication.ServiceCredential{}, false, nil
	}
	credential, err := validateServicePrincipal(id, secrets, scopes, systemToken, APIServiceID)
	if err != nil {
		if !tenants.ValidServiceID(id) || len(secrets) == 0 || len(scopes) == 0 {
			return authentication.ServiceCredential{}, false, fmt.Errorf("%s, %s and %s must all be configured", APIServiceID, APIServiceSecrets, APIServiceScopes)
		}
		return authentication.ServiceCredential{}, false, err
	}
	credential.Dashboard = true
	return credential, true, nil
}

func parseServicePrincipalEntries(encoded string) ([]servicePrincipalConfig, error) {
	decoder := json.NewDecoder(strings.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var entries []servicePrincipalConfig
	if err := decoder.Decode(&entries); err != nil {
		return nil, fmt.Errorf("%s must be a JSON array of service principals: %w", APIServicePrincipals, err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%s must contain one JSON array of service principals", APIServicePrincipals)
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("%s must name at least one service principal when set", APIServicePrincipals)
	}
	return entries, nil
}

func validateServicePrincipal(id string, secrets, rawScopes []string, systemToken, source string) (authentication.ServiceCredential, error) {
	credential := authentication.ServiceCredential{ID: id, Secrets: append([]string(nil), secrets...)}
	if !tenants.ValidServiceID(id) || len(secrets) == 0 || len(rawScopes) == 0 {
		return authentication.ServiceCredential{}, fmt.Errorf("%s entries must each configure a valid id, at least one secret, and at least one scope", source)
	}
	for _, secret := range secrets {
		if !utf8.ValidString(secret) || utf8.RuneCountInString(secret) < 32 || apikeys.LooksLikeRawKey(secret) || secret == systemToken || strings.ContainsAny(secret, " \t\r\n") {
			return authentication.ServiceCredential{}, fmt.Errorf("%s entries must be valid UTF-8 of at least 32 characters, contain no whitespace, and not overlap other credentials", secretSourceName(source))
		}
	}
	for _, raw := range rawScopes {
		scope := authentication.Scope(raw)
		if !authentication.ValidScope(scope) {
			return authentication.ServiceCredential{}, fmt.Errorf("%s contains an invalid scope", scopeSourceName(source))
		}
		credential.Scopes = append(credential.Scopes, scope)
	}
	return credential, nil
}

func secretSourceName(source string) string {
	if source == APIServiceID {
		return APIServiceSecrets
	}
	return source
}

func scopeSourceName(source string) string {
	if source == APIServiceID {
		return APIServiceScopes
	}
	return source
}

func validateServicePrincipalSet(credentials []authentication.ServiceCredential) error {
	ids := make(map[string]bool, len(credentials))
	secretOwners := map[string]string{}
	dashboards := 0
	for _, credential := range credentials {
		if ids[credential.ID] {
			return fmt.Errorf("%s contains a duplicate service id", APIServicePrincipals)
		}
		ids[credential.ID] = true
		if credential.Dashboard {
			dashboards++
		}
		for _, secret := range credential.Secrets {
			if owner, exists := secretOwners[secret]; exists && owner != credential.ID {
				return fmt.Errorf("%s entries must not share a secret across service ids", APIServicePrincipals)
			}
			secretOwners[secret] = credential.ID
		}
	}
	if dashboards > 1 {
		return fmt.Errorf("%s must mark at most one dashboard service", APIServicePrincipals)
	}
	return nil
}
