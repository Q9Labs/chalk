package recorderworker

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
)

func (attempt *ProductionRenderAttempt) runTranscription(ctx context.Context) error {
	var resolved recordingrender.ResolvedInput
	err := attempt.measure(RenderAttemptStageResolveInput, func() error {
		var resolveErr error
		resolved, resolveErr = withRenderAuthority(attempt, func(authority recordingrender.Authority) (recordingrender.ResolvedInput, error) {
			return attempt.config.Control.ResolveRenderInput(ctx, authority)
		})
		return resolveErr
	})
	if err != nil {
		return fmt.Errorf("resolve recording transcription input: %w", err)
	}
	if err := attempt.validateResolvedInput(resolved); err != nil {
		return err
	}
	if resolved.TranscriptionMode != artifactpolicy.TranscriptionAutomatic && resolved.TranscriptionMode != artifactpolicy.TranscriptionOnDemand {
		return fmt.Errorf("%w: transcription preparation requires an enabled policy", ErrInvalidProductionRenderAttempt)
	}

	downloads, err := newRenderInputDownloader(attempt, resolved)
	if err != nil {
		return err
	}
	presentationPath := filepath.Join(attempt.workspace, "presentation.json")
	bundleDirectory := filepath.Join(attempt.workspace, "bundles")
	if err := os.Mkdir(bundleDirectory, 0o700); err != nil {
		return fmt.Errorf("create recording transcription bundle directory: %w", err)
	}
	if err := attempt.measure(RenderAttemptStageDownloadPresentation, func() error {
		return downloads.download(ctx, resolved.Presentation, presentationPath)
	}); err != nil {
		return fmt.Errorf("download recording transcription presentation: %w", err)
	}
	presentationBytes, err := os.ReadFile(presentationPath)
	if err != nil {
		return fmt.Errorf("read recording transcription presentation: %w", err)
	}
	timeline, err := recordingpresentation.Decode(presentationBytes)
	if err != nil {
		return fmt.Errorf("decode recording transcription presentation: %w", err)
	}
	if err := attempt.validateTranscriptionTimeline(resolved, timeline); err != nil {
		return err
	}
	var bundles []recordingdecode.BundleFile
	err = attempt.measure(RenderAttemptStageDownloadCapture, func() error {
		var downloadErr error
		bundles, _, downloadErr = attempt.downloadCapture(ctx, downloads, resolved, bundleDirectory)
		return downloadErr
	})
	if err != nil {
		return err
	}
	var dataKeys []recordingdecode.DataKey
	err = attempt.measure(RenderAttemptStageAccessCaptureKeys, func() error {
		var accessErr error
		dataKeys, accessErr = attempt.accessCaptureKeys(ctx, resolved.Capture)
		return accessErr
	})
	if err != nil {
		return err
	}
	defer clearDecodeDataKeys(dataKeys)
	decodedDirectory := filepath.Join(attempt.workspace, "decoded")
	var decoded recordingdecode.Result
	err = attempt.measure(RenderAttemptStageSourcePreparation, func() error {
		var decodeErr error
		decoded, decodeErr = attempt.config.Decode(ctx, recordingdecode.Request{
			RecordingID: timeline.RecordingID, EpisodeID: timeline.EpisodeID, TenantID: resolved.TenantID.String(),
			Environment: attempt.config.Environment, OriginAuthorityID: timeline.Clock.OriginAuthorityID,
			CaptureEpoch: resolved.CaptureEpoch, DurationMS: resolved.DurationMillis, OutputDirectory: decodedDirectory,
			FFmpegPath: attempt.config.FFmpegPath, Presentation: timeline, Bundles: bundles, DataKeys: dataKeys,
			IncludedSourceKinds: []recordingpresentation.MediaKind{recordingpresentation.MediaKindMicrophone},
		})
		return decodeErr
	})
	clearDecodeDataKeys(dataKeys)
	if err != nil {
		return fmt.Errorf("decode authenticated recording microphone media: %w", err)
	}
	var source *recordingrender.TranscriptionSource
	err = attempt.measure(RenderAttemptStagePersistTranscription, func() error {
		var persistErr error
		source, persistErr = attempt.persistTranscription(ctx, resolved, timeline, decodedDirectory, decoded.Index)
		return persistErr
	})
	if err != nil {
		return err
	}
	err = attempt.measure(RenderAttemptStageCommit, func() error {
		_, commitErr := withRenderAuthority(attempt, func(authority recordingrender.Authority) (*recordingrender.TranscriptionResult, error) {
			input := recordingrender.TranscriptionPreparationInput{
				Authority: authority, PresentationSHA256: append([]byte(nil), resolved.PresentationSHA256...),
				DurationMillis: resolved.DurationMillis, TranscriptionSource: source,
			}
			digest, digestErr := recordingrender.TranscriptionPreparationDigest(input)
			if digestErr != nil {
				return nil, fmt.Errorf("digest recording transcription preparation: %w", digestErr)
			}
			input.CommitDigest = digest
			result, innerCommitErr := attempt.config.Control.CommitTranscriptionPreparation(ctx, input)
			if innerCommitErr == nil {
				attempt.mu.Lock()
				attempt.committed = true
				attempt.mu.Unlock()
			}
			return result, innerCommitErr
		})
		return commitErr
	})
	if err != nil {
		return fmt.Errorf("commit recording transcription preparation: %w", err)
	}
	return nil
}

func (attempt *ProductionRenderAttempt) validateTranscriptionTimeline(input recordingrender.ResolvedInput, timeline recordingpresentation.Timeline) error {
	if timeline.SchemaVersion != input.PresentationSchemaVersion || timeline.RecordingID != input.RecordingID.String() || timeline.EpisodeID != input.EpisodeID.String() ||
		timeline.Clock.CaptureEpoch != input.CaptureEpoch || timeline.Clock.DurationMillis != input.DurationMillis || timeline.Clock.Origin != "capture_ready" || timeline.Clock.Timebase != "recording_relative_ms" {
		return fmt.Errorf("%w: recording presentation does not match transcription authority", ErrInvalidProductionRenderAttempt)
	}
	return nil
}

func isTranscriptionRenderJob(kind recordingpipeline.JobKind) bool {
	return kind == recordingpipeline.JobKindTranscription
}

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
