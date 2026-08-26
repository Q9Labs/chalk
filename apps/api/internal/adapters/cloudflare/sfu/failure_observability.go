package sfu

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const maxProviderMessageRunes = 240

var (
	providerCodePattern    = regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,63}$`)
	providerURLPattern     = regexp.MustCompile(`https?://\S+`)
	providerUUIDPattern    = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b`)
	providerTokenPattern   = regexp.MustCompile(`\b[A-Za-z0-9_-]{32,}\b`)
	providerNumberPattern  = regexp.MustCompile(`[0-9]+`)
	providerUnicodePattern = regexp.MustCompile(`[^\x00-\x7F]+`)
	providerWordPattern    = regexp.MustCompile(`[A-Za-z]+`)
)

var observableProviderWords = map[string]struct{}{
	"a": {}, "add": {}, "already": {}, "and": {}, "answer": {}, "are": {}, "at": {}, "bad": {}, "because": {},
	"cannot": {}, "closed": {}, "close": {}, "connected": {}, "connecting": {}, "connection": {}, "create": {},
	"description": {}, "duplicate": {}, "duplicated": {}, "error": {}, "expired": {}, "failed": {}, "for": {},
	"found": {}, "has": {}, "in": {}, "internal": {}, "invalid": {}, "is": {}, "media": {}, "missing": {},
	"not": {}, "offer": {}, "operation": {}, "provider": {}, "rate": {}, "ready": {}, "redacted": {}, "rejected": {}, "request": {},
	"required": {}, "response": {}, "session": {}, "state": {}, "the": {}, "this": {}, "timeout": {}, "too": {},
	"track": {}, "tracks": {}, "unavailable": {}, "unauthorized": {}, "unknown": {}, "unsupported": {}, "was": {},
}

type providerFailureDetails struct {
	rawCode            string
	message            string
	messageFingerprint string
	responseBytes      int
	requestTrackCount  int
	localTrackCount    int
	remoteTrackCount   int
	responseTrackCount int
	failedTrackCount   int
}

func newProviderResponseFailure(operation string, stage providerFailureStage, statusCode int, rawCode string, message string, responseTrackCount int, failedTrackCount int) providerFailure {
	failure := newProviderFailure(operation, stage, statusCode, providerResponseCode(rawCode, message))
	failure.details = providerFailureDetails{
		rawCode:            observableProviderCode(rawCode, normalizedProviderCode(rawCode)),
		message:            observableProviderMessage(message),
		messageFingerprint: providerMessageFingerprint(message),
		responseTrackCount: responseTrackCount,
		failedTrackCount:   failedTrackCount,
	}
	return failure
}

func (e providerFailure) MissingRemoteTracks() []mediaplane.RemoteTrackIdentity {
	if len(e.missingRemoteTracks) == 0 {
		return nil
	}
	return append([]mediaplane.RemoteTrackIdentity(nil), e.missingRemoteTracks...)
}

func (e providerFailure) ExactRemoteTrackAbsence() bool {
	return e.exactRemoteAbsence
}

func (e providerFailure) PartialRemoteTrackResponse() bool {
	return e.partialRemoteTracks
}

func providerResponseCode(rawCode string, message string) string {
	if normalizedProviderCode(rawCode) == "unknown" && isTrackNotFoundDescription(message) {
		return "track_not_found"
	}
	return providerRejectionCode(rawCode)
}

func isTrackNotFoundDescription(message string) bool {
	message = strings.ToLower(strings.TrimSpace(message))
	const prefix = "track not found"
	if message == prefix {
		return true
	}
	for _, suffix := range []string{" ", ":", ".", "-", "[", "("} {
		if strings.HasPrefix(message, prefix+suffix) {
			return true
		}
	}
	message = strings.TrimRight(message, ".")
	return strings.Contains(message, " track ") && strings.Contains(message, " is connected and ") && strings.HasSuffix(message, " for this track")
}

func enrichProviderFailure(err error, body any, responseBytes int) error {
	var failure providerFailure
	if !errors.As(err, &failure) {
		return err
	}
	failure.details.responseBytes = responseBytes
	failure.details.requestTrackCount, failure.details.localTrackCount, failure.details.remoteTrackCount = providerRequestTrackCounts(body)
	return failure
}

func providerRequestTrackCounts(body any) (total int, local int, remote int) {
	switch request := body.(type) {
	case tracksRequest:
		for _, track := range request.Tracks {
			total++
			if track.Location == "local" {
				local++
			} else if track.Location == "remote" {
				remote++
			}
		}
	case closeTracksRequest:
		total = len(request.Tracks)
	}
	return total, local, remote
}

func observableProviderCode(rawCode string, normalizedCode string) string {
	rawCode = strings.TrimSpace(rawCode)
	if normalizedCode != "unknown" || !providerCodePattern.MatchString(rawCode) {
		return ""
	}
	return rawCode
}

func observableProviderMessage(message string) string {
	message = strings.Join(strings.Fields(message), " ")
	if message == "" {
		return ""
	}
	message = providerURLPattern.ReplaceAllString(message, "[redacted]")
	message = providerUUIDPattern.ReplaceAllString(message, "[redacted]")
	message = providerTokenPattern.ReplaceAllString(message, "[redacted]")
	message = providerNumberPattern.ReplaceAllString(message, "[redacted]")
	message = providerUnicodePattern.ReplaceAllString(message, "[redacted]")
	message = providerWordPattern.ReplaceAllStringFunc(message, func(word string) string {
		if _, ok := observableProviderWords[strings.ToLower(word)]; ok {
			return word
		}
		return "[redacted]"
	})
	message = strings.Join(strings.Fields(message), " ")
	runes := []rune(message)
	if len(runes) > maxProviderMessageRunes {
		message = string(runes[:maxProviderMessageRunes]) + "…"
	}
	return message
}

func providerMessageFingerprint(message string) string {
	message = strings.TrimSpace(message)
	if message == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(message))
	return hex.EncodeToString(digest[:8])
}
