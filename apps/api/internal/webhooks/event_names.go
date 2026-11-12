package webhooks

import (
	"slices"
	"strings"
)

// EventName is the name of a webhook event. Every Go spelling of an event name
// reads these constants. The SQL check constraints, the contract schema in
// contract/webhooks/v1 and the SDK that is generated from it spell the same
// names, and TestEventNamesMatchEverySpelling fails when one of them drifts.
type EventName string

const (
	EventSpaceCreated        EventName = "space.created"
	EventSpaceUpdated        EventName = "space.updated"
	EventSpaceArchived       EventName = "space.archived"
	EventSpaceRestored       EventName = "space.restored"
	EventEpisodeStarted      EventName = "episode.started"
	EventEpisodeEnded        EventName = "episode.ended"
	EventParticipantJoined   EventName = "participant.joined"
	EventParticipantLeft     EventName = "participant.left"
	EventRecordingStarted    EventName = "recording.started"
	EventRecordingCompleted  EventName = "recording.completed"
	EventRecordingFailed     EventName = "recording.failed"
	EventTranscriptStarted   EventName = "transcript.started"
	EventTranscriptCompleted EventName = "transcript.completed"
	EventTranscriptFailed    EventName = "transcript.failed"
	// EventEndpointTest is sent on request to one endpoint. No endpoint subscribes to it.
	EventEndpointTest EventName = "endpoint.test"
)

// subscribable lists the events an endpoint can subscribe to, in the order the
// API documents them.
var subscribable = []EventName{
	EventEpisodeEnded, EventEpisodeStarted, EventParticipantJoined, EventParticipantLeft,
	EventRecordingStarted, EventRecordingCompleted, EventRecordingFailed,
	EventTranscriptStarted, EventTranscriptCompleted, EventTranscriptFailed,
	EventSpaceArchived, EventSpaceCreated, EventSpaceRestored, EventSpaceUpdated,
}

// SubscribableEventTypes lists the names an endpoint can subscribe to.
func SubscribableEventTypes() []string {
	names := make([]string, len(subscribable))
	for i, name := range subscribable {
		names[i] = string(name)
	}
	return names
}

// AllEventTypes lists every event name a delivery can carry, sorted.
func AllEventTypes() []string {
	return slices.Sorted(slices.Values(append(SubscribableEventTypes(), string(EventEndpointTest))))
}

// Subscribable says whether an endpoint can subscribe to name.
func (n EventName) Subscribable() bool { return slices.Contains(subscribable, n) }

// Known says whether name is an event Chalk sends.
func (n EventName) Known() bool { return n == EventEndpointTest || n.Subscribable() }

// Resource names the kind of resource the event is about: "space" for "space.created".
func (n EventName) Resource() string {
	resource, _, _ := strings.Cut(string(n), ".")
	return resource
}

func (n EventName) isOneOf(names ...EventName) bool { return slices.Contains(names, n) }
