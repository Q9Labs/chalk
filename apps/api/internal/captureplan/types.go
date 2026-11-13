package captureplan

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	SchemaVersion = "capture_plan.v1"

	MaximumParticipants    = 10
	MaximumTracks          = captureplane.MaxCaptureTracks
	MaximumParticipantName = 256
	MaximumPlanHandle      = captureplane.MaxProviderReference
	MaximumPublicationRef  = 256
	MaximumLeaseOwner      = 256
	MaximumLeaseToken      = 256
	MaximumInputBitrateBPS = int64(4_000_000)
	MaximumWait            = 30 * time.Second
	MinimumWait            = time.Millisecond
	DefaultPollInterval    = 100 * time.Millisecond
)

// LayoutProfile identifies the deterministic renderer layout rules used by a
// capture plan.
type LayoutProfile string

const (
	LayoutProfileComposite720PV1 LayoutProfile = "composite_720p_v1"
)

// These aliases keep the capture-plane vocabulary available at the plan
// boundary without introducing duplicate wire types.
type CaptureEpoch = captureplane.CaptureEpoch
type PlanRevision = captureplane.PlanRevision
type ProviderReference = captureplane.ProviderReference
type TrackSource = captureplane.TrackSource
type TrackKind = captureplane.TrackKind
type TrackLayer = captureplane.TrackLayer

// StopState is the durable stop state carried by an immutable plan snapshot.
type StopState string

const (
	StopStateRunning   StopState = "running"
	StopStateRequested StopState = "requested"
	StopStateStopped   StopState = "stopped"
)

// ParticipantLifecycle is the bounded Sync lifecycle state needed by capture.
type ParticipantLifecycle string

const (
	ParticipantActive ParticipantLifecycle = "active"
	ParticipantLeft   ParticipantLifecycle = "left"
)

// PublicationReference is the opaque Chalk publication identity selected for
// a participant's current media source.
type PublicationReference string

// PlanHandle identifies one mutable desired-state stream. Its contents are
// opaque to the capture-plan core.
type PlanHandle string

// PlanCursors are the source cursors represented by a plan snapshot. They are
// intentionally numeric so a source can advance each stream independently.
type PlanCursors struct {
	EpisodeControlRevision int64 `json:"episode_control_revision"`
	ProviderIncarnation    int64 `json:"provider_incarnation"`
	ProviderSequence       int64 `json:"provider_sequence"`
}

// PlanAuthority is the complete server-issued identity for one worker
// attempt. EnvelopeDigest is copied whenever this value crosses the domain
// boundary.
type PlanAuthority struct {
	PlanHandle        PlanHandle
	TenantID          utilities.ID
	SpaceID           utilities.ID
	EpisodeID         utilities.ID
	RecordingID       utilities.ID
	JobID             utilities.ID
	AttemptCount      int
	FencingGeneration int64
	CaptureEpoch      captureplane.CaptureEpoch
	EnvelopeDigest    []byte
}

// ParticipantSnapshot is the immutable participant fact consumed by layout
// reconciliation. JoinOrdinal is Sync admission_revision and never changes
// when a participant reconnects.
type ParticipantSnapshot struct {
	ID          utilities.ID
	Generation  int64
	DisplayName string
	JoinOrdinal int64
	Lifecycle   ParticipantLifecycle
}

// TrackSnapshot binds a current publication to a participant generation and
// provider-owned capture references. RequestedLayer is auto in capture_plan.v1.
type TrackSnapshot struct {
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Source                captureplane.TrackSource
	Kind                  captureplane.TrackKind
	OwnerReference        captureplane.ProviderReference
	TrackReference        captureplane.ProviderReference
	OwnerMID              captureplane.ProviderReference
	PublicationReference  PublicationReference
	RequestedLayer        captureplane.TrackLayer
}

// PlanInput contains the facts needed to construct a validated immutable Plan.
// Slices and EnvelopeDigest are copied by NewPlan.
type PlanInput struct {
	Authority         PlanAuthority
	Revision          captureplane.PlanRevision
	Cursors           PlanCursors
	LayoutProfile     LayoutProfile
	ParticipantLimit  int
	InputBitrateBPS   int64
	EffectiveDeadline time.Time
	StopState         StopState
	StopRequestedAt   time.Time
	Participants      []ParticipantSnapshot
	Tracks            []TrackSnapshot
}

// Plan is an immutable canonical capture plan. The constructor is the only
// way to create a valid value; accessors return copies where needed.
type Plan struct {
	authority         PlanAuthority
	revision          captureplane.PlanRevision
	cursors           PlanCursors
	layoutProfile     LayoutProfile
	participantLimit  int
	inputBitrateBPS   int64
	effectiveDeadline time.Time
	stopState         StopState
	stopRequestedAt   time.Time
	participants      []ParticipantSnapshot
	tracks            []TrackSnapshot
	canonicalJSON     []byte
	fingerprint       [sha256.Size]byte
}

// NewPlan validates and freezes a capture plan. Participant and track slices
// are copied and canonically ordered before the fingerprint is calculated.
func NewPlan(input PlanInput) (Plan, error) {
	if err := validatePlanInput(input); err != nil {
		return Plan{}, err
	}

	authority := cloneAuthority(input.Authority)
	participants := append([]ParticipantSnapshot(nil), input.Participants...)
	tracks := append([]TrackSnapshot(nil), input.Tracks...)
	sortParticipants(participants)
	sortTracks(tracks)

	plan := Plan{
		authority:         authority,
		revision:          input.Revision,
		cursors:           input.Cursors,
		layoutProfile:     input.LayoutProfile,
		participantLimit:  input.ParticipantLimit,
		inputBitrateBPS:   input.InputBitrateBPS,
		effectiveDeadline: input.EffectiveDeadline.UTC(),
		stopState:         input.StopState,
		stopRequestedAt:   input.StopRequestedAt.UTC(),
		participants:      participants,
		tracks:            tracks,
	}

	canonical, err := plan.marshalCanonical()
	if err != nil {
		return Plan{}, err
	}
	plan.canonicalJSON = canonical
	plan.fingerprint = sha256.Sum256(canonical)
	return plan, nil
}

// Validate confirms that the immutable value still contains a valid plan.
func (p Plan) Validate() error {
	if p.IsZero() {
		return ErrInvalidPlan
	}
	input := PlanInput{
		Authority:         cloneAuthority(p.authority),
		Revision:          p.revision,
		Cursors:           p.cursors,
		LayoutProfile:     p.layoutProfile,
		ParticipantLimit:  p.participantLimit,
		InputBitrateBPS:   p.inputBitrateBPS,
		EffectiveDeadline: p.effectiveDeadline,
		StopState:         p.stopState,
		StopRequestedAt:   p.stopRequestedAt,
		Participants:      append([]ParticipantSnapshot(nil), p.participants...),
		Tracks:            append([]TrackSnapshot(nil), p.tracks...),
	}
	if err := validatePlanInput(input); err != nil {
		return err
	}
	canonical, err := p.marshalCanonical()
	if err != nil {
		return err
	}
	if !bytes.Equal(canonical, p.canonicalJSON) || sha256.Sum256(canonical) != p.fingerprint {
		return fmt.Errorf("%w: canonical representation changed", ErrInvalidPlan)
	}
	return nil
}

func (p Plan) IsZero() bool {
	return p.authority.PlanHandle == ""
}

func (p Plan) Authority() PlanAuthority { return cloneAuthority(p.authority) }

func (p Plan) Revision() captureplane.PlanRevision { return p.revision }

func (p Plan) Cursors() PlanCursors { return p.cursors }

func (p Plan) LayoutProfile() LayoutProfile { return p.layoutProfile }

func (p Plan) ParticipantLimit() int { return p.participantLimit }

func (p Plan) InputBitrateBPS() int64 { return p.inputBitrateBPS }

func (p Plan) EffectiveDeadline() time.Time { return p.effectiveDeadline }

func (p Plan) StopState() StopState { return p.stopState }

func (p Plan) StopRequestedAt() time.Time { return p.stopRequestedAt }

func (p Plan) Participants() []ParticipantSnapshot {
	return append([]ParticipantSnapshot(nil), p.participants...)
}

func (p Plan) Tracks() []TrackSnapshot {
	return append([]TrackSnapshot(nil), p.tracks...)
}

func validOpaque(value string, maximum int) bool {
	return value != "" && len(value) <= maximum && strings.TrimSpace(value) == value && utf8.ValidString(value)
}

func digestIsValid(digest []byte) bool {
	if len(digest) != sha256.Size {
		return false
	}
	for _, value := range digest {
		if value != 0 {
			return true
		}
	}
	return false
}

var (
	ErrInvalidPlan           = errors.New("invalid capture plan")
	ErrInvalidAuthority      = errors.New("invalid capture plan authority")
	ErrInvalidParticipant    = errors.New("invalid capture plan participant")
	ErrInvalidTrack          = errors.New("invalid capture plan track")
	ErrInvalidWaitInput      = errors.New("invalid capture plan wait input")
	ErrPlanAuthorityMismatch = errors.New("capture plan authority does not match worker fence")
	ErrStalePlan             = errors.New("capture repository returned a stale plan")
	ErrNoChange              = errors.New("capture plan has no change")
	ErrWaitTimeout           = errors.New("capture plan wait timed out without a change")
	ErrRepositoryUnavailable = errors.New("capture plan repository is unavailable")
	ErrLeaseExpired          = errors.New("capture plan worker lease expired")
)
