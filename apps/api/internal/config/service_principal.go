package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode"
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

	additional, err := decodeServiceCredentials(raw)
	if err != nil {
		return nil, "", fmt.Errorf("%s must be a JSON array of objects with exactly the fields id, secrets and scopes", APIServicePrincipals)
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

var errInvalidServiceCredentials = errors.New("invalid service credentials")

func decodeServiceCredentials(raw string) ([]authentication.ServiceCredential, error) {
	var entries []json.RawMessage
	decoder := json.NewDecoder(strings.NewReader(raw))
	if !utf8.ValidString(raw) || decoder.Decode(&entries) != nil || entries == nil || decoder.Decode(new(json.RawMessage)) != io.EOF {
		return nil, errInvalidServiceCredentials
	}
	credentials := make([]authentication.ServiceCredential, 0, len(entries))
	for _, entry := range entries {
		credential, err := decodeServiceCredential(entry)
		if err != nil {
			return nil, err
		}
		credentials = append(credentials, credential)
	}
	return credentials, nil
}

// encoding/json matches field names case-insensitively and lets a repeated
// key overwrite an earlier one, so "id" and "ID" in one object could bind one
// service's secrets to another service's ID. Check the keys exactly first.
func decodeServiceCredential(entry json.RawMessage) (authentication.ServiceCredential, error) {
	decoder := json.NewDecoder(bytes.NewReader(entry))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return authentication.ServiceCredential{}, errInvalidServiceCredentials
	}
	seen := make(map[string]bool, 3)
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] || (key != "id" && key != "secrets" && key != "scopes") {
			return authentication.ServiceCredential{}, errInvalidServiceCredentials
		}
		seen[key] = true
		if err := decoder.Decode(new(json.RawMessage)); err != nil {
			return authentication.ServiceCredential{}, errInvalidServiceCredentials
		}
	}
	var credential authentication.ServiceCredential
	if err := json.Unmarshal(entry, &credential); err != nil {
		return authentication.ServiceCredential{}, errInvalidServiceCredentials
	}
	return credential, nil
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

// Bearer parsing trims Unicode whitespace, so a secret containing any would be
// compared against a different string than the one presented.
func validServiceSecret(secret, systemToken string) bool {
	return utf8.ValidString(secret) && utf8.RuneCountInString(secret) >= 32 && !apikeys.LooksLikeRawKey(secret) && secret != systemToken && strings.IndexFunc(secret, unicode.IsSpace) < 0
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
