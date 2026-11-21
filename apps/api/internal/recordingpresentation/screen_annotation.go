package recordingpresentation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
)

const (
	ScreenAnnotationAssetKind = "screen_annotation"
	maximumAnnotationBytes    = 32 << 20
)

// ScreenAnnotationFact is a private capture checkpoint and its revisioned changes.
// All input timestamps are on the server wall clock.
type ScreenAnnotationFact struct {
	CaptureEpoch     int64                            `json:"capture_epoch"`
	PublicationID    captureplan.PublicationReference `json:"publication_id"`
	SharerGeneration int64                            `json:"sharer_generation"`
	Layer            annotationLayer                  `json:"layer"`
	InitialAtMS      int64                            `json:"initial_at_ms"`
	InitialRevision  int64                            `json:"initial_revision"`
	InitialPaused    bool                             `json:"initial_paused"`
	InitialMarks     []annotationMark                 `json:"initial_marks"`
	ClosedAtMS       int64                            `json:"closed_at_ms"`
	Changes          []annotationRevision             `json:"changes"`
}

type annotationLayer struct {
	ID            string                           `json:"layer_id"`
	PublicationID captureplan.PublicationReference `json:"publication_id"`
	SharerID      string                           `json:"sharer_id"`
	Frame         struct {
		Width  int `json:"width"`
		Height int `json:"height"`
	} `json:"frame"`
}

type annotationMark struct {
	Draft           json.RawMessage `json:"draft"`
	Author          json.RawMessage `json:"author"`
	CreatedRevision int64           `json:"created_revision"`
	CommittedAtMS   int64           `json:"committed_at_ms"`
	ExpiresAtMS     *int64          `json:"expires_at_ms"`
}

type annotationRevision struct {
	AtMS     int64           `json:"atMs"`
	Revision int64           `json:"revision"`
	Change   json.RawMessage `json:"change"`
}

type annotationCheckpoint struct {
	AtMS     int64            `json:"atMs"`
	Revision int64            `json:"revision"`
	Paused   bool             `json:"paused"`
	Marks    []annotationMark `json:"marks"`
}

type annotationSidecar struct {
	Version    int                  `json:"version"`
	Layer      annotationLayer      `json:"layer"`
	Initial    annotationCheckpoint `json:"initial"`
	Changes    []annotationRevision `json:"changes"`
	ClosedAtMS int64                `json:"closedAtMs"`
}

type boundAnnotation struct {
	SourceIDs []string          `json:"sourceIds"`
	Sidecar   annotationSidecar `json:"sidecar"`
}

type annotationSourceKey struct {
	epoch       int64
	publication captureplan.PublicationReference
	sharer      string
	generation  int64
}

type annotationSources map[annotationSourceKey]map[string]struct{}

// Collect source IDs from the same plan transitions that populate the frozen
// timeline. A capture epoch or track replacement must not inherit another
// publication's marks, even when the same person keeps sharing.
func (sources annotationSources) collect(active map[string]activeTrack) {
	for _, track := range active {
		if track.publication == "" || track.source.Kind != MediaKindScreenShare {
			continue
		}
		key := annotationSourceKey{track.captureEpoch, track.publication, track.source.ParticipantID, track.source.ParticipantGeneration}
		if sources[key] == nil {
			sources[key] = make(map[string]struct{})
		}
		sources[key][track.source.SourceID] = struct{}{}
	}
}

func addScreenAnnotationAsset(source CompletionSource, sources annotationSources, materials *[]assetMaterial, assetByID map[string]int) error {
	origin := source.CaptureReadyAt.UnixMilli()
	layers := make([]boundAnnotation, 0, len(source.ScreenAnnotation))
	for _, fact := range source.ScreenAnnotation {
		key := annotationSourceKey{fact.CaptureEpoch, fact.PublicationID, fact.Layer.SharerID, fact.SharerGeneration}
		if fact.Layer.PublicationID != fact.PublicationID || fact.CaptureEpoch <= 0 || fact.CaptureEpoch > source.CaptureEpoch {
			return fmt.Errorf("%w: invalid annotation checkpoint authority", ErrInvalidCompletionSource)
		}
		ids := sources[key]
		if len(ids) == 0 {
			continue
		}
		sidecar, hasInk, err := fact.onCaptureClock(origin, source.DurationMillis)
		if err != nil {
			return err
		}
		if !hasInk {
			continue
		}
		sourceIDs := make([]string, 0, len(ids))
		for id := range ids {
			sourceIDs = append(sourceIDs, id)
		}
		sort.Strings(sourceIDs)
		layers = append(layers, boundAnnotation{SourceIDs: sourceIDs, Sidecar: sidecar})
	}
	if len(layers) == 0 {
		return nil
	}

	body, err := json.Marshal(struct {
		Version           int               `json:"version"`
		RecordingID       string            `json:"recordingId"`
		EpisodeID         string            `json:"episodeId"`
		OriginAuthorityID string            `json:"originAuthorityId"`
		CaptureEpoch      int64             `json:"captureEpoch"`
		Layers            []boundAnnotation `json:"layers"`
	}{1, source.RecordingID.String(), source.EpisodeID.String(), source.PresentationHandle.String(), source.CaptureEpoch, layers})
	if err != nil {
		return fmt.Errorf("encode recording screen annotations: %w", err)
	}
	if len(body) > maximumAnnotationBytes || len(*materials) >= MaximumAssets {
		// Annotation is optional. Never fail the media export because the
		// encoded sidecar or asset inventory has no room left.
		return nil
	}
	digest := sha256.Sum256(body)
	digestHex := hex.EncodeToString(digest[:])
	asset := Asset{
		ID: ScreenAnnotationAssetKind, Kind: ScreenAnnotationAssetKind,
		ObjectKey:   presentationObjectPrefix(source) + "/assets/screen-annotation-" + digestHex + ".json",
		ContentType: "application/json", ByteSize: int64(len(body)), SHA256: digestHex,
	}
	return addAssetMaterial(assetMaterial{Asset: asset, Body: body}, materials, assetByID)
}

func (fact ScreenAnnotationFact) onCaptureClock(origin, duration int64) (annotationSidecar, bool, error) {
	initialAt := max(int64(0), fact.InitialAtMS-origin)
	closedAt := min(duration, fact.ClosedAtMS-origin)
	if initialAt >= closedAt {
		return annotationSidecar{}, false, nil
	}
	initialMarks := make([]annotationMark, 0, len(fact.InitialMarks))
	for _, mark := range fact.InitialMarks {
		if mark.ExpiresAtMS == nil || *mark.ExpiresAtMS > origin+initialAt {
			initialMarks = append(initialMarks, mark.relativeTo(origin))
		}
	}
	sidecar := annotationSidecar{
		Version: 1, Layer: fact.Layer, ClosedAtMS: closedAt,
		Initial: annotationCheckpoint{initialAt, fact.InitialRevision, fact.InitialPaused, initialMarks},
		Changes: make([]annotationRevision, 0, len(fact.Changes)),
	}
	lastAt := initialAt
	hasInk := len(initialMarks) != 0
	for _, revision := range fact.Changes {
		at := max(lastAt, revision.AtMS-origin)
		if at >= closedAt {
			break
		}
		var header struct {
			Kind string          `json:"kind"`
			Mark *annotationMark `json:"mark"`
		}
		if err := json.Unmarshal(revision.Change, &header); err != nil {
			return annotationSidecar{}, false, fmt.Errorf("read recorded screen annotation: %w", err)
		}
		switch header.Kind {
		case "upsert":
			if header.Mark == nil {
				return annotationSidecar{}, false, fmt.Errorf("%w: missing recorded mark", ErrInvalidCompletionSource)
			}
			mark := header.Mark.relativeTo(origin)
			header.Mark = &mark
			change, err := json.Marshal(header)
			if err != nil {
				return annotationSidecar{}, false, fmt.Errorf("encode recorded mark: %w", err)
			}
			revision.Change = change
			hasInk = true
		case "remove", "clear", "control":
		default:
			return annotationSidecar{}, false, fmt.Errorf("%w: invalid recorded annotation change", ErrInvalidCompletionSource)
		}
		revision.AtMS = at
		lastAt = at
		sidecar.Changes = append(sidecar.Changes, revision)
	}
	return sidecar, hasInk, nil
}

func (mark annotationMark) relativeTo(origin int64) annotationMark {
	mark.CommittedAtMS -= origin
	if mark.ExpiresAtMS != nil {
		expires := *mark.ExpiresAtMS - origin
		mark.ExpiresAtMS = &expires
	}
	return mark
}
