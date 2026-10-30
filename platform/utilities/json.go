package utilities

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
)

var ErrInvalidJSON = errors.New("invalid json")

const RedactedValue = "[redacted]"

// OptionalJSON represents an optional JSON value where omitted, explicit null,
// and a concrete JSON document have distinct meanings.
type OptionalJSON struct {
	Set   bool
	Value json.RawMessage
}

func (j *OptionalJSON) UnmarshalJSON(data []byte) error {
	j.Set = true

	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		j.Value = nil
		return nil
	}

	value, err := JSON(data)
	if err != nil {
		return err
	}

	j.Value = value
	return nil
}

func JSON(data []byte) (json.RawMessage, error) {
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, nil
	}

	if !json.Valid(data) {
		return nil, ErrInvalidJSON
	}

	value := make(json.RawMessage, len(data))
	copy(value, data)
	return value, nil
}

func OptionalNullableJSON(value OptionalJSON) (OptionalJSON, error) {
	if !value.Set {
		return value, nil
	}

	prepared, err := JSON(value.Value)
	if err != nil {
		return OptionalJSON{}, err
	}

	return OptionalJSON{Set: true, Value: prepared}, nil
}

func RedactJSONSecrets(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}

	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return map[string]string{"status": "unreadable"}
	}

	return RedactSecrets(value)
}

func RedactSecrets(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		redacted := make(map[string]any, len(typed))
		for key, value := range typed {
			if SecretFieldName(key) {
				redacted[key] = RedactedValue
				continue
			}
			redacted[key] = RedactSecrets(value)
		}
		return redacted
	case []any:
		redacted := make([]any, 0, len(typed))
		for _, value := range typed {
			redacted = append(redacted, RedactSecrets(value))
		}
		return redacted
	default:
		return value
	}
}

func SecretFieldName(name string) bool {
	normalized := secretFieldName(name)
	compact := strings.ReplaceAll(normalized, "_", "")
	return normalized == "secret" ||
		normalized == "token" ||
		normalized == "private_key" ||
		normalized == "api_key" ||
		normalized == "api_token" ||
		normalized == "app_secret" ||
		normalized == "client_secret" ||
		normalized == "credential" ||
		normalized == "credentials" ||
		normalized == "secret_key" ||
		normalized == "auth" ||
		normalized == "authorization" ||
		normalized == "auth_header" ||
		normalized == "authorization_header" ||
		normalized == "access_token" ||
		normalized == "refresh_token" ||
		normalized == "bearer_token" ||
		normalized == "secret_access_key" ||
		normalized == "password" ||
		strings.HasSuffix(normalized, "_password") ||
		strings.Contains(compact, "credential") ||
		strings.Contains(compact, "authorization") ||
		strings.HasSuffix(normalized, "_secret") ||
		strings.HasSuffix(normalized, "_token") ||
		strings.HasSuffix(normalized, "_api_key") ||
		strings.HasSuffix(normalized, "_api_token") ||
		strings.HasSuffix(normalized, "_auth") ||
		strings.HasSuffix(normalized, "_auth_header") ||
		strings.HasSuffix(normalized, "_secret_key") ||
		strings.HasSuffix(normalized, "_secret_access_key") ||
		strings.HasSuffix(normalized, "_private_key") ||
		compact == "apikey" ||
		compact == "apitoken" ||
		compact == "authheader" ||
		compact == "authorizationheader" ||
		compact == "appsecret" ||
		compact == "clientsecret" ||
		compact == "secretkey" ||
		compact == "privatekey" ||
		compact == "secretaccesskey" ||
		compact == "password" ||
		strings.Contains(compact, "privatekey") ||
		strings.HasSuffix(compact, "apikey") ||
		strings.HasSuffix(compact, "apitoken") ||
		strings.HasSuffix(compact, "authtoken") ||
		strings.HasSuffix(compact, "password") ||
		strings.HasSuffix(compact, "secretkey") ||
		strings.HasSuffix(compact, "secretaccesskey") ||
		strings.HasSuffix(compact, "authheader")
}

func secretFieldName(name string) string {
	normalized := strings.TrimSpace(name)
	var builder strings.Builder
	for index, r := range normalized {
		switch {
		case r == '-' || r == ' ':
			builder.WriteByte('_')
		case r >= 'A' && r <= 'Z':
			if index > 0 {
				builder.WriteByte('_')
			}
			builder.WriteRune(r + ('a' - 'A'))
		default:
			builder.WriteRune(r)
		}
	}
	return builder.String()
}
