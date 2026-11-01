package mediapublications

// Proof-branch diagnostics only: one JSON log line per registry write, close and confirm.

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func diagParticipantRecords(participant utilities.ID, publications []provideroperations.Publication) []string {
	records := []string{}
	for _, publication := range publications {
		if publication.ParticipantID != participant {
			continue
		}
		reference, err := ParseReference(publication.PublicationID)
		if err != nil {
			records = append(records, fmt.Sprintf("%s enabled=%t id=none", publication.Source, publication.Enabled))
			continue
		}
		records = append(records, fmt.Sprintf("%s enabled=%t conn=%s track=%s mid=%s gen=%d", publication.Source, publication.Enabled, reference.ConnectionID, reference.TrackName, reference.MID, reference.ParticipantGeneration))
	}
	return records
}

func diagRegistryWrite(ctx context.Context, input RecordInput, next provideroperations.ObservationInput, attempt int, err error) {
	tracks := make([]string, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		tracks = append(tracks, fmt.Sprintf("%s track=%s mid=%s", track.Source, track.TrackName, track.MID))
	}
	result := "accepted"
	if err != nil {
		result = err.Error()
	}
	slog.WarnContext(ctx, "diag registry write", "event", "diag.registry_write",
		"participant", input.ParticipantID.String(), "generation", input.ParticipantGeneration, "connection", input.ConnectionID,
		"tracks", tracks, "attempt", attempt, "sequence", next.Sequence, "result", result,
		"participant_records", diagParticipantRecords(input.ParticipantID, next.Publications))
}

func diagRegistryClose(ctx context.Context, input CloseInput, outcome string, err error) {
	result := outcome
	if err != nil {
		result = outcome + ": " + err.Error()
	}
	slog.WarnContext(ctx, "diag registry close", "event", "diag.registry_close",
		"participant", input.ParticipantID.String(), "source", input.Source, "connection", input.ConnectionID, "mid", input.MID,
		"publication_id", input.PublicationID, "result", result)
}
