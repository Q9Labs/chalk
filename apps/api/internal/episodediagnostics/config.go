package episodediagnostics

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	MaxConfigRoles        = 64
	MaxConfigCapabilities = 128
	MaxConfigSummaryBytes = 16 * 1024
	MinConfigDuration     = int64(60)
	MaxConfigDuration     = int64(7 * 24 * 60 * 60)
)

var ErrInvalidConfigSummary = errors.New("invalid Episode config summary")

// EpisodeConfigSummaryV1 is the only config shape that may cross the
// diagnostics domain boundary. It intentionally contains policy counts and
// bounded durations, never admission payloads, role capability names, or raw
// customer-defined config.
type EpisodeConfigSummaryV1 struct {
	SchemaVersion                 string `json:"schemaVersion"`
	AdmissionMode                 string `json:"admissionMode,omitempty"`
	RoleCount                     int    `json:"roleCount,omitempty"`
	CapabilityCount               int    `json:"capabilityCount,omitempty"`
	DefaultEpisodeDurationSeconds int64  `json:"defaultEpisodeDurationSeconds,omitempty"`
	MaximumEpisodeDurationSeconds int64  `json:"maximumEpisodeDurationSeconds,omitempty"`
	LingerWindowSeconds           int64  `json:"lingerWindowSeconds,omitempty"`
}

// EpisodeConfigSummary is kept as a short alias for package consumers.
type EpisodeConfigSummary = EpisodeConfigSummaryV1

// SummarizeEpisodeConfig parses only the allowlisted Episode policy fields.
// Unknown fields are deliberately ignored; callers never receive the input
// object back, even when it contains content or credentials.
func SummarizeEpisodeConfig(raw []byte) (EpisodeConfigSummaryV1, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return EpisodeConfigSummaryV1{SchemaVersion: "EpisodeConfigSummary/v1"}, nil
	}
	if len(trimmed) > MaxConfigSummaryBytes {
		return EpisodeConfigSummaryV1{}, fmt.Errorf("%w: config exceeds %d bytes", ErrInvalidConfigSummary, MaxConfigSummaryBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	var object map[string]json.RawMessage
	if err := decoder.Decode(&object); err != nil || object == nil {
		return EpisodeConfigSummaryV1{}, fmt.Errorf("%w: expected an object", ErrInvalidConfigSummary)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return EpisodeConfigSummaryV1{}, fmt.Errorf("%w: trailing JSON", ErrInvalidConfigSummary)
	}

	result := EpisodeConfigSummaryV1{SchemaVersion: "EpisodeConfigSummary/v1"}
	if policy, ok := object["admission_policy"]; ok {
		var value struct {
			Mode string `json:"mode"`
		}
		if err := json.Unmarshal(policy, &value); err != nil || value.Mode == "" {
			return EpisodeConfigSummaryV1{}, fmt.Errorf("%w: admission_policy", ErrInvalidConfigSummary)
		}
		switch value.Mode {
		case "open", "knock", "members_only":
			result.AdmissionMode = value.Mode
		default:
			return EpisodeConfigSummaryV1{}, fmt.Errorf("%w: admission_policy.mode", ErrInvalidConfigSummary)
		}
	}
	if roles, ok := object["roles"]; ok {
		var values map[string][]string
		if err := json.Unmarshal(roles, &values); err != nil || len(values) > MaxConfigRoles {
			return EpisodeConfigSummaryV1{}, fmt.Errorf("%w: roles", ErrInvalidConfigSummary)
		}
		result.RoleCount = len(values)
		for _, capabilities := range values {
			result.CapabilityCount += len(capabilities)
			if result.CapabilityCount > MaxConfigCapabilities {
				return EpisodeConfigSummaryV1{}, fmt.Errorf("%w: capabilities", ErrInvalidConfigSummary)
			}
		}
	}
	seenDefault, seenMaximum, seenLinger := false, false, false
	for key, target := range map[string]*int64{
		"default_episode_duration_seconds": &result.DefaultEpisodeDurationSeconds,
		"maximum_episode_duration_seconds": &result.MaximumEpisodeDurationSeconds,
		"linger_window_seconds":            &result.LingerWindowSeconds,
	} {
		value, ok := object[key]
		if !ok {
			continue
		}
		switch key {
		case "default_episode_duration_seconds":
			seenDefault = true
		case "maximum_episode_duration_seconds":
			seenMaximum = true
		case "linger_window_seconds":
			seenLinger = true
		}
		var number json.Number
		if err := json.Unmarshal(value, &number); err != nil {
			return EpisodeConfigSummaryV1{}, fmt.Errorf("%w: %s", ErrInvalidConfigSummary, key)
		}
		parsed, err := number.Int64()
		if err != nil || parsed < 0 {
			return EpisodeConfigSummaryV1{}, fmt.Errorf("%w: %s", ErrInvalidConfigSummary, key)
		}
		if key != "linger_window_seconds" && (parsed < MinConfigDuration || parsed > MaxConfigDuration) {
			return EpisodeConfigSummaryV1{}, fmt.Errorf("%w: %s out of bounds", ErrInvalidConfigSummary, key)
		}
		if key == "linger_window_seconds" && parsed > MaxConfigDuration {
			return EpisodeConfigSummaryV1{}, fmt.Errorf("%w: %s out of bounds", ErrInvalidConfigSummary, key)
		}
		*target = parsed
	}
	if seenDefault && seenMaximum && result.DefaultEpisodeDurationSeconds > result.MaximumEpisodeDurationSeconds {
		return EpisodeConfigSummaryV1{}, fmt.Errorf("%w: default duration exceeds maximum", ErrInvalidConfigSummary)
	}
	if seenLinger && seenMaximum && result.LingerWindowSeconds > result.MaximumEpisodeDurationSeconds {
		return EpisodeConfigSummaryV1{}, fmt.Errorf("%w: linger window exceeds maximum", ErrInvalidConfigSummary)
	}
	return result, nil
}

// SummarizeEpisodeConfigMap is the adapter seam used after a repository maps
// jsonb into a Go object. It serializes only in memory and returns the bounded
// summary; callers should discard the source map immediately.
func SummarizeEpisodeConfigMap(raw map[string]any) (EpisodeConfigSummaryV1, error) {
	if len(raw) == 0 {
		return EpisodeConfigSummaryV1{SchemaVersion: "EpisodeConfigSummary/v1"}, nil
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return EpisodeConfigSummaryV1{}, fmt.Errorf("%w: encode config", ErrInvalidConfigSummary)
	}
	return SummarizeEpisodeConfig(encoded)
}

// SafeConfigSummary returns a copy of the bounded summary and is intentionally
// the only accessor offered to API-facing code.
func (d EpisodeDiagnostic) SafeConfigSummary() EpisodeConfigSummaryV1 {
	if d.ConfigSummary != nil {
		return *d.ConfigSummary
	}
	summary, err := SummarizeEpisodeConfigMap(d.ConfigSnapshot)
	if err != nil {
		return EpisodeConfigSummaryV1{SchemaVersion: "EpisodeConfigSummary/v1"}
	}
	return summary
}

func sanitizeDiagnosticConfig(diagnostic EpisodeDiagnostic) EpisodeDiagnostic {
	summary, err := SummarizeEpisodeConfigMap(diagnostic.ConfigSnapshot)
	if err == nil {
		diagnostic.ConfigSummary = &summary
	}
	// Do not let raw policy remain attached to a domain value returned by the
	// service, even if the repository supplied malformed/unknown keys.
	diagnostic.ConfigSnapshot = nil
	return diagnostic
}
