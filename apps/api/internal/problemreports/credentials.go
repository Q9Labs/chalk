package problemreports

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"html"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

type credentialContextKey struct{}

// WithRequestCredentials retains authenticated request credentials only for the
// rejection check. They never enter Delivery or persisted evidence.
func WithRequestCredentials(ctx context.Context, credentials ...string) context.Context {
	return context.WithValue(ctx, credentialContextKey{}, append([]string(nil), credentials...))
}

func normalizeCredentialText(text string) string {
	// Nested entities and compatibility-width ASCII must not hide credentials.
	for {
		normalized := norm.NFKC.String(html.UnescapeString(text))
		if normalized == text {
			return text
		}
		text = normalized
	}
}

func credentialLetter(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9'
}

func normalizedCredentialView(text string) string {
	return strings.Map(func(r rune) rune {
		if credentialLetter(r) {
			return r
		}
		return -1
	}, normalizeCredentialText(text))
}

func containsKnownCredential(text string, credentials []string) bool {
	view := []rune(normalizeCredentialText(text))
	for _, credential := range credentials {
		// Literal configured values are secrets even in short local setups. Only
		// separator-tolerant matching needs a distinctive normalized length.
		if credential != "" && strings.Contains(text, credential) {
			return true
		}
		known := []rune(strings.Map(func(r rune) rune {
			if unicode.IsSpace(r) || unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
				return -1
			}
			return r
		}, normalizeCredentialText(credential)))
		// Short normalized values do not get separator-tolerant matching. Count
		// intrinsic punctuation too; the literal check above applies at every length.
		if len(known) < 16 {
			continue
		}
		for start, first := range view {
			if first != known[0] {
				continue
			}
			matched := 0
			for _, character := range view[start:] {
				if character == known[matched] {
					matched++
					if matched == len(known) {
						return true
					}
				} else if unicode.IsLetter(character) || unicode.IsNumber(character) {
					break
				}
				// Ignore inserted separators, but consume every intrinsic credential
				// character, including punctuation. Never compact a secret down to "a".
			}
		}
	}
	return false
}

func containsCredential(text string) bool {
	text = normalizeCredentialText(text)
	// A password in URL userinfo is a credential even when Chalk did not issue
	// or configure it. Public URLs without passwords remain ordinary report text.
	for _, candidate := range credentialURL.FindAllString(text, -1) {
		if parsed, err := url.Parse(candidate); err == nil && parsed.User != nil {
			if _, password := parsed.User.Password(); password {
				return true
			}
		}
	}
	// Only known credential formats use a fully compacted view. Joining all
	// ordinary words would make virtually every paragraph look like base64url.
	compact := normalizedCredentialView(text)
	if structuredCredential.MatchString(compact) || containsJWT(compact) {
		return true
	}
	var public strings.Builder
	var boundaries []bool
	previousIsIdentifier := false
	for _, r := range text {
		if credentialLetter(r) || r == '_' || r == '-' {
			public.WriteRune(r)
			boundaries = append(boundaries, !previousIsIdentifier)
		}
		previousIsIdentifier = unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' || r == '-'
	}
	view := public.String()
	for offset := 0; offset < len(view); {
		match := prefixedCredential.FindStringIndex(view[offset:])
		if match == nil {
			break
		}
		start := offset + match[0]
		if boundaries[start] {
			return true
		}
		// A false match inside task_ must not hide a later real key.
		offset = start + 1
	}
	return containsJWT(view)
}

var credentialURL = regexp.MustCompile("(?i)(?:[a-z][a-z0-9+.-]*:)?//[^\\s<>\"`]+")

func containsJWT(text string) bool {
	for offset := 0; offset < len(text); {
		index := strings.Index(text[offset:], "eyJ")
		if index < 0 {
			break
		}
		offset += index
		candidate := jwtCandidate.FindString(text[offset:])
		offset += 3
		if candidate == "" {
			continue
		}
		// Decode the header rather than treating every "eyJ" substring as a JWT.
		// Joined unpadded segments can produce a trailing decode error; the header
		// bytes still decode completely, and the JSON decoder reads that object only.
		decoded, _ := base64.RawURLEncoding.DecodeString(candidate)
		var header struct {
			Algorithm string `json:"alg"`
		}
		if json.NewDecoder(bytes.NewReader(decoded)).Decode(&header) == nil && header.Algorithm != "" {
			return true
		}
	}
	return false
}

var (
	jwtCandidate         = regexp.MustCompile(`^eyJ[A-Za-z0-9_-]+`)
	structuredCredential = regexp.MustCompile(`(?:cspi1[A-Za-z0-9]{32,}|chalksk[A-Za-z0-9]{40,}|AKIA[A-Z0-9]{16}|BEGIN(?:RSA|EC|OPENSSH|ENCRYPTED)?PRIVATEKEY|discord(?:app)?comapi(?:v[0-9]+)?webhooks[A-Za-z0-9]{16,})`)
	prefixedCredential   = regexp.MustCompile(`(?:(?:sk|pk)_(?:(?:live|test|proj)_)?[A-Za-z0-9_-]{16,}|(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{30,})`)
)
