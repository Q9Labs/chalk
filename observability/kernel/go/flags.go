package obs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

var flagKey = regexp.MustCompile(`^[a-z][a-z0-9_.]*$`)

// CanonicalFlags is the flags map as canonical JSON: keys sorted, no whitespace, and values limited to strings,
// booleans, nil and integers, so the TypeScript, Go and Elixir kernels hash the same bytes.
func CanonicalFlags(flags map[string]any) (string, error) {
	keys := make([]string, 0, len(flags))
	for key := range flags {
		if !flagKey.MatchString(key) {
			return "", fmt.Errorf("obs: flag key %q must be lower snake_case with dots", key)
		}
		keys = append(keys, key)
	}
	slices.Sort(keys)
	var out strings.Builder
	out.WriteByte('{')
	for index, key := range keys {
		if index > 0 {
			out.WriteByte(',')
		}
		value, err := flagValue(key, flags[key])
		if err != nil {
			return "", err
		}
		out.WriteString(jsonString(key) + ":" + value)
	}
	out.WriteByte('}')
	return out.String(), nil
}

// FlagsHash is 16 hex characters of the SHA-256 of the canonical flags JSON.
func FlagsHash(flags map[string]any) (string, error) {
	canonical, err := CanonicalFlags(flags)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(sum[:])[:16], nil
}

func flagValue(key string, value any) (string, error) {
	switch typed := value.(type) {
	case nil:
		return "null", nil
	case bool:
		return strconv.FormatBool(typed), nil
	case string:
		return jsonString(typed), nil
	case int:
		return strconv.Itoa(typed), nil
	case int64:
		return strconv.FormatInt(typed, 10), nil
	case float64:
		if typed == math.Trunc(typed) && math.Abs(typed) <= 1<<53-1 {
			return strconv.FormatInt(int64(typed), 10), nil
		}
	}
	return "", fmt.Errorf("obs: flag %s must be a string, boolean, integer or null, not %v", key, value)
}

// jsonString escapes like JavaScript's JSON.stringify: quote, backslash and control characters only.
func jsonString(text string) string {
	var out strings.Builder
	out.WriteByte('"')
	for _, r := range text {
		switch r {
		case '"':
			out.WriteString(`\"`)
		case '\\':
			out.WriteString(`\\`)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&out, `\u%04x`, r)
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
	return out.String()
}

// Flags is the effective config switches, kill switches and caps: strings, booleans, integers or nil.
type Flags map[string]any

// SetFlags records the full flags map and stamps its hash on every later record. Call it at boot and on change.
func SetFlags(ctx context.Context, flags Flags) {
	st := current.Load()
	hash, err := FlagsHash(flags)
	if err != nil {
		violate(st, []string{err.Error()})
		return
	}
	next := *st
	next.flagsHash = hash
	current.Store(&next)
	send(ctx, &next, "fact", EventObsFlagsSnapshot, []slog.Attr{slog.Any(FieldFlags, map[string]any(flags))}, nil, false)
}
