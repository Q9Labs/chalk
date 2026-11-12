package spaces

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// MaxNameCodePoints is shared by Space creation, renaming and problem reporting.
const MaxNameCodePoints = 120

var (
	ErrInvalidSpaceID             = errors.New("invalid space id")
	ErrInvalidTenantID            = errors.New("invalid tenant id")
	ErrInvalidSpaceName           = errors.New("invalid space name")
	ErrInvalidSpaceSlug           = errors.New("invalid space slug")
	ErrInvalidMediaPlane          = errors.New("invalid media plane")
	ErrInvalidAdmissionPolicy     = errors.New("invalid admission policy")
	ErrInvalidEpisodeDuration     = errors.New("invalid episode duration")
	ErrInvalidEpisodeCeiling      = errors.New("invalid episode duration ceiling")
	ErrInvalidLingerWindow        = errors.New("invalid linger window")
	ErrInvalidSpaceField          = errors.New("invalid space field")
	ErrInvalidRecordingPolicy     = errors.New("invalid Recording policy")
	ErrInvalidTranscriptionPolicy = errors.New("invalid Transcription policy")
	ErrSpaceNotFound              = errors.New("space not found")
	ErrSpaceSlugAlreadyUsed       = errors.New("space slug already used")
	ErrInvalidRequestKey          = errors.New("invalid space request key")
	ErrIdempotencyConflict        = errors.New("space request key conflicts with original request")
)

const (
	MinimumEpisodeDurationSeconds int32 = 60
	MaximumEpisodeDurationSeconds int32 = 7 * 24 * 60 * 60

	// These defaults keep a newly created Space usable when callers omit
	// optional policy values. The database carries the same defaults for direct
	// inserts, while the service validates values before crossing the boundary.
	DefaultEpisodeDurationSeconds        int32 = 24 * 60 * 60
	DefaultMaximumEpisodeDurationSeconds int32 = 24 * 60 * 60
	DefaultLingerWindowSeconds           int32 = 0
)

var DefaultAdmissionPolicy = json.RawMessage(`{"mode":"open"}`)

var allCapabilities = []string{
	"publishAudio", "publishVideo", "publishScreen", "subscribe",
	"raiseHand", "renameSelf", "sendChat", "sendReaction", "drawWhiteboard",
	"manageWhiteboard", "manageAdmission", "assignRoles", "muteOthers",
	"stopVideoOthers", "stopScreenOthers", "requestMediaOthers",
	"removeParticipant", "manageRecording", "startEpisode", "extendEpisode",
	"endEpisode", "manageMembers", "clearSpaceContent",
}

var spaceRequestKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// DefaultRole is the product-provided role bundle seeded with each Space.
// Role names are defaults, not authority checks; customers may rename or
// extend them after creation.
type DefaultRole struct {
	Name         string
	Capabilities []string
}

// DefaultRoles returns a fresh copy of the three ratified role bundles so an
// adapter can persist them without allowing a caller to mutate package state.
func DefaultRoles() []DefaultRole {
	roles := []DefaultRole{
		{Name: "owner", Capabilities: append([]string(nil), allCapabilities...)},
		{Name: "collaborator", Capabilities: []string{
			"publishAudio", "publishVideo", "publishScreen", "subscribe", "raiseHand",
			"renameSelf", "sendChat", "sendReaction", "drawWhiteboard",
		}},
		{Name: "observer", Capabilities: []string{"subscribe", "sendReaction"}},
	}
	return roles
}

type Space struct {
	ID       utilities.ID
	Name     string
	TenantID utilities.ID
	Slug     string
	// MediaPlane is what the previous release reads. The Space's own choice is
	// MediaPlaneSetting, and nil means it inherits.
	MediaPlane                    string
	MediaPlaneSetting             *MediaPlaneProvider
	Metadata                      json.RawMessage
	RecurringPolicy               json.RawMessage
	AdmissionPolicy               json.RawMessage
	RecordingPolicy               artifactpolicy.RecordingMode
	TranscriptLanguage            *artifactpolicy.TranscriptLanguage
	TranscriptionPolicy           artifactpolicy.TranscriptionMode
	DefaultEpisodeDurationSeconds int32
	MaximumEpisodeDurationSeconds int32
	LingerWindowSeconds           int32
	ArchivedAt                    *time.Time
	Roles                         []Role
	CreatedByUserID               utilities.ID
	UpdatedAt                     time.Time
	CreatedAt                     time.Time
}

type Role struct {
	ID           utilities.ID
	TenantID     utilities.ID
	SpaceID      utilities.ID
	Name         string
	Capabilities []string
}

type Repository interface {
	CreateSpace(ctx context.Context, input CreateSpaceInput) (Space, error)
	GetSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (Space, error)
	ListSpaces(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (SpaceList, error)
	UpdateSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID, input UpdateSpaceInput) (Space, error)
}

// ArchiveRepository is the persistence seam for the reversible Space
// lifecycle controls. Archive keeps all Episodes and their artifacts while
// preventing new live activity; restore makes the Space joinable again.
type ArchiveRepository interface {
	ArchiveSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (Space, error)
	RestoreSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (Space, error)
}

type IdempotentRepository interface {
	CreateSpaceIdempotent(ctx context.Context, input CreateSpaceInput) (Space, error)
}

// FilteredRepository optionally supports the dashboard's archived-state
// filter without changing the original list method used by older callers.
type FilteredRepository interface {
	ListSpacesFiltered(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest, archived *bool) (SpaceList, error)
}

// TenantReader gives Create Space the Tenant's media plane settings, so a new
// Space never defaults to a plane its Tenant cannot serve.
type TenantReader interface {
	GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error)
}

// The column defaults of spaces.recording_policy and spaces.transcription_policy
// (migrations 20261003120000 and 20261024120000). A new Space that omits a policy
// and gets no configured default stores these.
const (
	DatabaseDefaultRecordingPolicy     = artifactpolicy.RecordingAutomatic
	DatabaseDefaultTranscriptionPolicy = artifactpolicy.TranscriptionAutomatic
)

// NewSpaceDefaults are the values a Create Space request gets for the fields it
// omits. A zero field leaves that field to the deployment default, or to the
// database default for the two policies.
type NewSpaceDefaults struct {
	MediaPlane          MediaPlaneProvider
	RecordingPolicy     artifactpolicy.RecordingMode
	TranscriptionPolicy artifactpolicy.TranscriptionMode
}

type CreateSpaceInput struct {
	ID                 utilities.ID
	PublicInviteHandle [32]byte
	Name               string
	TenantID           utilities.ID
	Slug               string
	MediaPlane         string
	MediaPlaneSet      bool
	// MediaPlaneFromConfig means MediaPlane comes from deployment configuration, not
	// from a caller's request, so the public write gate does not apply to it.
	MediaPlaneFromConfig bool
	// MediaPlaneSetting is the Space's own choice; nil inherits. The service fills
	// it and MediaPlane from the request, so a caller sets only MediaPlane.
	MediaPlaneSetting             *MediaPlaneProvider
	Metadata                      json.RawMessage
	RecurringPolicy               json.RawMessage
	AdmissionPolicy               json.RawMessage
	RecordingPolicy               artifactpolicy.RecordingMode
	RecordingPolicySet            bool
	TranscriptLanguage            *artifactpolicy.TranscriptLanguage
	TranscriptionPolicy           artifactpolicy.TranscriptionMode
	TranscriptionPolicySet        bool
	DefaultEpisodeDurationSeconds int32
	MaximumEpisodeDurationSeconds int32
	LingerWindowSeconds           int32
	CreatedByUserID               utilities.ID
	RequestKey                    string
	RequestFingerprint            [32]byte
}

type UpdateSpaceInput struct {
	Name utilities.OptionalString
	Slug utilities.OptionalString
	// MediaPlane is the request value: a plane, or null to inherit. The service
	// turns it into MediaPlaneSetting and the dual-written stored value.
	MediaPlane                    utilities.OptionalString
	MediaPlaneSetting             OptionalMediaPlaneSetting
	Metadata                      utilities.OptionalJSON
	RecurringPolicy               utilities.OptionalJSON
	AdmissionPolicy               utilities.OptionalJSON
	RecordingPolicy               OptionalRecordingPolicy
	TranscriptLanguage            artifactpolicy.OptionalTranscriptLanguage
	TranscriptionPolicy           OptionalTranscriptionPolicy
	DefaultEpisodeDurationSeconds OptionalInt32
	MaximumEpisodeDurationSeconds OptionalInt32
	LingerWindowSeconds           OptionalInt32
}

// OptionalMediaPlaneSetting is an omitted, cleared (Value nil) or concrete setting.
type OptionalMediaPlaneSetting struct {
	Set   bool
	Value *MediaPlaneProvider
}

// OptionalInt32 preserves omitted, explicit null, and concrete numeric JSON
// values for PATCH requests without leaking database nullable types into the
// service package.
type OptionalInt32 struct {
	Set   bool
	Value *int32
}

type OptionalRecordingPolicy struct {
	Set   bool
	Value *artifactpolicy.RecordingMode
}

type OptionalTranscriptionPolicy struct {
	Set   bool
	Value *artifactpolicy.TranscriptionMode
}

func (value *OptionalInt32) UnmarshalJSON(data []byte) error {
	value.Set = true
	if strings.TrimSpace(string(data)) == "null" {
		value.Value = nil
		return nil
	}

	var number int64
	if err := json.Unmarshal(data, &number); err != nil || number < math.MinInt32 || number > math.MaxInt32 {
		return errors.New("invalid int32")
	}
	converted := int32(number)
	value.Value = &converted
	return nil
}

type SpaceList struct {
	Spaces []Space
	Page   pagination.Page
}
