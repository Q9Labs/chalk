package recordingpresentation

import (
	"fmt"
	"time"
)

func schedulePlanTail(source CompletionSource, active map[string]activeTrack, originRevision int64, appendEvent func(int64, int, Event)) (map[string]activeTrack, int64, error) {
	previousRevision := int64(0)
	endRevision := originRevision
	for _, fact := range source.CapturePlans {
		if fact.Revision != previousRevision+1 {
			return nil, 0, fmt.Errorf("%w: capture plan gap", ErrInvalidCompletionSource)
		}
		previousRevision = fact.Revision
		if fact.Revision <= source.CapturePlanStartRevision {
			continue
		}
		// The API freezes the plan cursor before the worker's capture-ready
		// callback. A newer plan can already exist on the API clock while its
		// timestamp precedes the worker's origin. Keep that state transition at
		// zero rather than discard captured media. Revisions, identities, missing
		// timestamps and the end boundary still undergo their normal validation.
		createdAt := fact.CreatedAt
		if !createdAt.IsZero() && createdAt.Before(source.CaptureReadyAt) {
			createdAt = source.CaptureReadyAt
		}
		at, err := elapsedMillis(source, createdAt)
		if err != nil {
			return nil, 0, err
		}
		desired, err := tracksForPlan(source, fact, active)
		if err != nil {
			return nil, 0, err
		}
		priorShared := screenSharedContent(active)
		nextShared := screenSharedContent(desired)
		sharedChanged := !whiteboardPresentedAt(source, fact.CreatedAt) && priorShared != nextShared
		clearedShared := false
		if sharedChanged && priorShared.Kind == "screen_share" {
			oldSourceVisible := false
			for _, track := range desired {
				if track.source.SourceID == priorShared.SourceID && track.source.Visible {
					oldSourceVisible = true
					break
				}
			}
			if !oldSourceVisible {
				appendEvent(at, 19, &SharedContentChangedEvent{Kind: "shared_content_changed", SharedContent: SharedContent{Kind: "none"}})
				clearedShared = true
			}
		}
		keys := unionTrackKeys(active, desired)
		for _, key := range keys {
			prior, hadPrior := active[key]
			next, hasNext := desired[key]
			if hadPrior && (!hasNext || prior.source.SourceID != next.source.SourceID) {
				hidden := prior.source
				hidden.Visible = false
				if prior.source.Visible {
					appendEvent(at, 20, &MediaSourceChangedEvent{Kind: "media_source_changed", Source: hidden})
				}
				appendParticipantMediaState(at, prior.source.ParticipantID, prior.source.Kind, false, appendEvent)
			}
			if hasNext && (!hadPrior || prior.source.SourceID != next.source.SourceID) {
				appendEvent(at, 20, &MediaSourceChangedEvent{Kind: "media_source_changed", Source: next.source})
				appendParticipantMediaState(at, next.source.ParticipantID, next.source.Kind, true, appendEvent)
			}
		}
		if sharedChanged && (!clearedShared || nextShared.Kind != "none") {
			appendEvent(at, 22, &SharedContentChangedEvent{Kind: "shared_content_changed", SharedContent: nextShared})
		}
		active = desired
		endRevision = fact.Revision
	}
	return active, endRevision, nil
}

func screenSharedContent(active map[string]activeTrack) SharedContent {
	var screen *MediaSource
	for _, track := range active {
		if track.source.Kind != MediaKindScreenShare || !track.source.Visible {
			continue
		}
		candidate := track.source
		if screen == nil || candidate.ParticipantID < screen.ParticipantID {
			screen = &candidate
		}
	}
	if screen == nil {
		return SharedContent{Kind: "none"}
	}
	return SharedContent{Kind: "screen_share", ParticipantID: screen.ParticipantID, SourceID: screen.SourceID}
}

func screenSharedAt(source CompletionSource, at time.Time) (SharedContent, error) {
	active := make(map[string]activeTrack)
	previous := int64(0)
	for _, fact := range source.CapturePlans {
		if fact.Revision != previous+1 {
			return SharedContent{}, fmt.Errorf("%w: capture plan gap", ErrInvalidCompletionSource)
		}
		previous = fact.Revision
		if fact.CreatedAt.After(at) {
			break
		}
		var err error
		active, err = tracksForPlan(source, fact, active)
		if err != nil {
			return SharedContent{}, err
		}
	}
	participants, err := controlParticipantsAtTime(source, at)
	if err != nil {
		return SharedContent{}, err
	}
	if err := hideDepartedMedia(participants, active); err != nil {
		return SharedContent{}, err
	}
	return screenSharedContent(active), nil
}
