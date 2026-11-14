package utilities

import (
	"bytes"
	"encoding/json"
	"errors"
	"slices"
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

var (
	secretNames          = []string{"secret", "token", "auth"}
	secretNameSuffixes   = []string{"_secret", "_token", "_auth"}
	secretCompactParts   = []string{"credential", "authorization", "privatekey"}
	secretCompactSuffix  = []string{"apikey", "apitoken", "authtoken", "authheader", "password", "secretkey", "secretaccesskey"}
	secretCompactMatches = []string{"appsecret", "clientsecret"}
)

// SecretFieldName reports whether a JSON field name holds a secret, ignoring case, dashes, spaces
// and underscores.
func SecretFieldName(name string) bool {
	normalized := secretFieldName(name)
	compact := strings.ReplaceAll(normalized, "_", "")
	return slices.Contains(secretNames, normalized) ||
		slices.Contains(secretCompactMatches, compact) ||
		slices.ContainsFunc(secretNameSuffixes, func(s string) bool { return strings.HasSuffix(normalized, s) }) ||
		slices.ContainsFunc(secretCompactParts, func(s string) bool { return strings.Contains(compact, s) }) ||
		slices.ContainsFunc(secretCompactSuffix, func(s string) bool { return strings.HasSuffix(compact, s) })
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
