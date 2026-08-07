package main

import (
	"crypto/sha256"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
)

type appendBatch struct {
	ParticipantIndex int
	FirstEvent       int64
	Count            int
}

func batches(value config) []appendBatch {
	if value.Events == 0 {
		return nil
	}
	result := make([]appendBatch, 0, int((value.Events+int64(value.BatchSize)-1)/int64(value.BatchSize)))
	base := value.Events / int64(value.Participants)
	remaining := value.Events % int64(value.Participants)
	var first int64
	for participant := 0; participant < value.Participants; participant++ {
		count := base
		if int64(participant) < remaining {
			count++
		}
		for offset := int64(0); offset < count; offset += int64(value.BatchSize) {
			batchCount := int64(value.BatchSize)
			if remainder := count - offset; remainder < batchCount {
				batchCount = remainder
			}
			result = append(result, appendBatch{ParticipantIndex: participant, FirstEvent: first + offset, Count: int(batchCount)})
		}
		first += count
	}
	return result
}

func makeAppendRequest(value config, batch appendBatch, participantID string, producerSequenceBase int64, startedAt time.Time) episodediagnostics.AppendDiagnosticEventsRequest {
	events := make([]episodediagnostics.DiagnosticEventDraft, batch.Count)
	operationRef := fmt.Sprintf("capacity-op-%03d", batch.ParticipantIndex)
	for index := range events {
		eventNumber := batch.FirstEvent + int64(index)
		events[index] = episodediagnostics.DiagnosticEventDraft{
			Version:              episodediagnostics.ContractVersion,
			EventID:              fmt.Sprintf("capacity-event-%09d", eventNumber),
			ProducerOperationRef: operationRef,
			ProducerSequence:     producerSequenceBase + eventNumber + 1,
			OccurredAt:           startedAt.Add(time.Duration(eventNumber) * time.Microsecond).UTC(),
			Source:               episodediagnostics.SourceSync,
			Name:                 "sync.connect",
			Phase:                "connected",
			State:                episodediagnostics.EventSucceeded,
			Attributes: episodediagnostics.DiagnosticAttributes{
				"status": "capacity",
			},
		}
	}
	return episodediagnostics.AppendDiagnosticEventsRequest{
		Version: episodediagnostics.ContractVersion,
		Producer: episodediagnostics.ProducerIdentity{
			ID:         string(episodediagnostics.SourceSync),
			InstanceID: value.ProducerInstance,
			Generation: 1,
		},
		Scope: &episodediagnostics.AppendScope{
			TenantID:      value.TenantID,
			SpaceID:       value.SpaceID,
			EpisodeID:     value.EpisodeID,
			ParticipantID: participantID,
		},
		Events: events,
	}
}

func participantIDs(count int) []string {
	result := make([]string, count)
	for index := range result {
		result[index] = syntheticUUID("participant", index)
	}
	return result
}

func syntheticUUID(namespace string, index int) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf("chalk-episode-diagnostics-capacity:%s:%d", namespace, index)))
	digest[6] = (digest[6] & 0x0f) | 0x40
	digest[8] = (digest[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", digest[0:4], digest[4:6], digest[6:8], digest[8:10], digest[10:16])
}

func sanitizedURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "invalid"
	}
	parsed.User = nil
	parsed.Path = ""
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return strings.TrimRight(parsed.String(), "/")
}

func validateRequestWire(request episodediagnostics.AppendDiagnosticEventsRequest) error {
	return episodediagnostics.ValidateAppendRequest(request)
}
