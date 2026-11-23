package recorderworker

import (
	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func participantDisplayNameAt(timeline recordingpresentation.Timeline, participantID string, atMillis int64) string {
	names := make(map[string]string, len(timeline.Initial.Participants))
	for _, participant := range timeline.Initial.Participants {
		names[participant.ID] = participant.DisplayName
	}
	for _, event := range timeline.Events {
		switch value := event.(type) {
		case recordingpresentation.ParticipantJoinedEvent:
			if value.AtMillis <= atMillis {
				names[value.Participant.ID] = value.Participant.DisplayName
			}
		case *recordingpresentation.ParticipantJoinedEvent:
			if value != nil && value.AtMillis <= atMillis {
				names[value.Participant.ID] = value.Participant.DisplayName
			}
		case recordingpresentation.ParticipantDisplayNameChangedEvent:
			if value.AtMillis <= atMillis {
				names[value.ParticipantID] = value.DisplayName
			}
		case *recordingpresentation.ParticipantDisplayNameChangedEvent:
			if value != nil && value.AtMillis <= atMillis {
				names[value.ParticipantID] = value.DisplayName
			}
		}
	}
	return names[participantID]
}

func microphoneOverlap(sources []recordingdecode.Source, currentID string, start, end int64) bool {
	for _, source := range sources {
		if source.SourceID != currentID && source.StartMS < end && source.EndMS > start {
			return true
		}
	}
	return false
}
