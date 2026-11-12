package media

import (
	"fmt"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// checkIdentifier refuses a value that is not a valid identifier, naming the field it came from.
func checkIdentifier(field, value string) error {
	if !protocol.IdentifierPattern.MatchString(value) {
		return fmt.Errorf("%w: %s must be %s", ErrInvalidRequest, field, protocol.IdentifierRule)
	}
	return nil
}

// ValidateScope rejects scopes that are empty or carry unexpected characters.
func ValidateScope(scope protocol.Scope) error {
	for name, value := range map[string]string{"tenantId": scope.TenantID, "episodeId": scope.EpisodeID, "participantId": scope.ParticipantID} {
		if err := checkIdentifier("scope."+name, value); err != nil {
			return err
		}
	}
	if scope.Generation < 1 {
		return fmt.Errorf("%w: scope.generation must be at least 1", ErrInvalidRequest)
	}
	return nil
}

// participantKey names one Participant, or one capture. A capture shares no namespace with
// Participants, so a capture named like a Participant neither replaces it nor takes its fence.
type participantKey struct {
	tenant, episode, participant string
	capture                      bool
}

func keyOf(scope protocol.Scope) participantKey {
	return participantKey{tenant: scope.TenantID, episode: scope.EpisodeID, participant: scope.ParticipantID}
}

func captureKeyOf(scope protocol.Scope) participantKey {
	key := keyOf(scope)
	key.capture = true
	return key
}

// sessionKind is what a session is for. A participant publishes and subscribes. A capture only pulls.
type sessionKind uint8

const (
	kindParticipant sessionKind = iota
	kindCapture
)

func kindOf(name string) (sessionKind, error) {
	switch name {
	case protocol.SessionKindParticipant:
		return kindParticipant, nil
	case protocol.SessionKindCapture:
		return kindCapture, nil
	}
	return 0, fmt.Errorf("%w: unknown session kind %q", ErrInvalidRequest, name)
}

func sameEpisode(a, b protocol.Scope) bool {
	return a.TenantID == b.TenantID && a.EpisodeID == b.EpisodeID
}

func sessionKey(scope protocol.Scope, kind sessionKind) participantKey {
	if kind == kindCapture {
		return captureKeyOf(scope)
	}
	return keyOf(scope)
}
