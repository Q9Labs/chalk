package spaces

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/calllength"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
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

var DefaultAdmissionPolicy = json.RawMessage(`{"mode":"open"}`)

var allCapabilities = []string{
	"publishAudio", "publishVideo", "publishScreen", "subscribe",
	"raiseHand", "renameSelf", "sendChat", "sendReaction", "drawWhiteboard",
	"manageWhiteboard", "manageAdmission", "assignRoles", "muteOthers",
	"stopVideoOthers", "stopScreenOthers", "requestMediaOthers",
	"removeParticipant", "manageRecording", "startEpisode", "extendEpisode",
	"endEpisode", "manageMembers", "clearSpaceContent", "focus.view",
	"focus.manage", "focus.exempt",
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
	MediaPlaneSetting             *mediaplane.Provider
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
// filter and activity order without changing the original list method used by older callers.
type FilteredRepository interface {
	ListSpacesFiltered(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest, options ListOptions) (SpaceList, error)
}

type Service struct {
	repository Repository
	newSpace   NewSpaceDefaults
	tenants    TenantReader
	killSwitch NewEpisodeSwitch
	planes     PlanePolicy
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
	MediaPlane          mediaplane.Provider
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
	MediaPlaneSetting             *mediaplane.Provider
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
	replayFingerprints            [][32]byte
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
	Value *mediaplane.Provider
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

func NewService(repository Repository) Service {
	return Service{repository: repository}
}

// WithPlanePolicy applies the deployment floor for new Episode admission.
func (s Service) WithPlanePolicy(policy PlanePolicy) Service {
	s.planes = policy
	return s
}

// WithNewEpisodeSwitch lets the effective plane follow the live kill switch.
func (s Service) WithNewEpisodeSwitch(killSwitch NewEpisodeSwitch) Service {
	s.killSwitch = killSwitch
	return s
}

// WithNewSpaceDefaults sets the artifact policies for new Spaces whose request
// does not name a media plane or supply those policies.
func (s Service) WithNewSpaceDefaults(defaults NewSpaceDefaults, tenants TenantReader) Service {
	s.newSpace = defaults
	s.tenants = tenants
	return s
}

func (s Service) CreateSpace(ctx context.Context, input CreateSpaceInput) (Space, error) {
	id, err := utilities.NewID()
	if err != nil {
		return Space{}, err
	}
	input.ID = id
	input.MediaPlaneSetting = nil
	explicitPlane := input.MediaPlaneSet || input.MediaPlane != ""
	if !explicitPlane {
		input.MediaPlane = mediaplane.ProviderChalkSFU.SettingName()
	}
	recordingPolicySet := input.RecordingPolicySet
	transcriptionPolicySet := input.TranscriptionPolicySet
	if !explicitPlane && !recordingPolicySet && s.newSpace.RecordingPolicy != "" {
		input.RecordingPolicy, input.RecordingPolicySet = s.newSpace.RecordingPolicy, true
	}
	if !explicitPlane && !transcriptionPolicySet && s.newSpace.TranscriptionPolicy != "" {
		input.TranscriptionPolicy, input.TranscriptionPolicySet = s.newSpace.TranscriptionPolicy, true
	}
	if _, err := rand.Read(input.PublicInviteHandle[:]); err != nil {
		return Space{}, err
	}
	if err := prepareCreateSpaceInput(&input); err != nil {
		return Space{}, err
	}
	if input.RequestKey != "" {
		if !spaceRequestKeyPattern.MatchString(input.RequestKey) {
			return Space{}, ErrInvalidRequestKey
		}
		if err := input.setCreateFingerprints(recordingPolicySet, transcriptionPolicySet); err != nil {
			return Space{}, err
		}
		idempotent, ok := s.repository.(IdempotentRepository)
		if !ok {
			return Space{}, errors.New("space idempotency repository unavailable")
		}
		return idempotent.CreateSpaceIdempotent(ctx, input)
	}

	return s.repository.CreateSpace(ctx, input)
}

func (s Service) GetSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (Space, error) {
	if err := validateTenantSpaceIDs(tenantID, spaceID); err != nil {
		return Space{}, err
	}

	return s.repository.GetSpace(ctx, tenantID, spaceID)
}

func (s Service) UpdateSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID, input UpdateSpaceInput) (Space, error) {
	if err := validateTenantSpaceIDs(tenantID, spaceID); err != nil {
		return Space{}, err
	}
	if err := prepareUpdateSpaceInput(&input); err != nil {
		return Space{}, err
	}
	input.MediaPlaneSetting = OptionalMediaPlaneSetting{}
	if input.MediaPlane.Set {
		if input.MediaPlane.Value != nil && !mediaplane.KnownSettingName(*input.MediaPlane.Value) {
			return Space{}, ErrInvalidMediaPlane
		}
		stored := mediaplane.ProviderChalkSFU.SettingName()
		input.MediaPlaneSetting = OptionalMediaPlaneSetting{Set: true}
		input.MediaPlane.Value = &stored
	}

	return s.repository.UpdateSpace(ctx, tenantID, spaceID, input)
}

func (s Service) ArchiveSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (Space, error) {
	if err := validateTenantSpaceIDs(tenantID, spaceID); err != nil {
		return Space{}, err
	}
	repository, ok := s.repository.(ArchiveRepository)
	if !ok {
		return Space{}, ErrSpaceNotFound
	}
	return repository.ArchiveSpace(ctx, tenantID, spaceID)
}

func (s Service) RestoreSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (Space, error) {
	if err := validateTenantSpaceIDs(tenantID, spaceID); err != nil {
		return Space{}, err
	}
	repository, ok := s.repository.(ArchiveRepository)
	if !ok {
		return Space{}, ErrSpaceNotFound
	}
	return repository.RestoreSpace(ctx, tenantID, spaceID)
}

func prepareCreateSpaceInput(input *CreateSpaceInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}

	name, err := utilities.RequiredString(input.Name)
	if err != nil || utf8.RuneCountInString(input.Name) > MaxNameCodePoints {
		return ErrInvalidSpaceName
	}
	input.Name = name

	slug, err := utilities.RequiredString(input.Slug)
	if err != nil {
		return ErrInvalidSpaceSlug
	}
	input.Slug = slug

	mediaPlane, err := utilities.RequiredString(input.MediaPlane)
	if err != nil {
		return ErrInvalidMediaPlane
	}
	provider, err := mediaplane.ParseSettingName(mediaPlane)
	if err != nil {
		return ErrInvalidMediaPlane
	}
	input.MediaPlane = provider.SettingName()

	input.Metadata, err = utilities.JSON(input.Metadata)
	if err != nil {
		return ErrInvalidSpaceField
	}
	input.RecurringPolicy, err = utilities.JSON(input.RecurringPolicy)
	if err != nil {
		return ErrInvalidSpaceField
	}
	input.AdmissionPolicy, err = prepareAdmissionPolicy(input.AdmissionPolicy)
	if err != nil {
		return err
	}
	if !input.RecordingPolicySet {
		// Keep omission placeholders stable for idempotent request fingerprints.
		// The repository passes NULL so database defaults decide new-row policy.
		input.RecordingPolicy = artifactpolicy.RecordingDisabled
	}
	if !input.TranscriptionPolicySet {
		input.TranscriptionPolicy = artifactpolicy.TranscriptionDisabled
	}
	if err := input.RecordingPolicy.Validate(); err != nil {
		return ErrInvalidRecordingPolicy
	}
	if err := input.TranscriptionPolicy.Validate(); err != nil {
		return ErrInvalidTranscriptionPolicy
	}
	applySpaceDefaults(input)
	if err := validateEpisodeDurations(input.DefaultEpisodeDurationSeconds, input.MaximumEpisodeDurationSeconds); err != nil {
		return err
	}
	if err := validateLingerWindow(input.LingerWindowSeconds); err != nil {
		return err
	}
	return nil
}

func prepareUpdateSpaceInput(input *UpdateSpaceInput) error {
	var err error

	if input.Name.Set && input.Name.Value != nil && utf8.RuneCountInString(*input.Name.Value) > MaxNameCodePoints {
		return ErrInvalidSpaceName
	}
	input.Name, err = requiredOptionalString(input.Name, ErrInvalidSpaceName)
	if err != nil {
		return err
	}
	input.Slug, err = requiredOptionalString(input.Slug, ErrInvalidSpaceSlug)
	if err != nil {
		return err
	}
	if input.MediaPlane.Set && input.MediaPlane.Value != nil {
		provider, parseErr := mediaplane.ParseSettingName(*input.MediaPlane.Value)
		if parseErr != nil {
			return ErrInvalidMediaPlane
		}
		value := provider.SettingName()
		input.MediaPlane.Value = &value
	}
	input.Metadata, err = utilities.OptionalNullableJSON(input.Metadata)
	if err != nil {
		return ErrInvalidSpaceField
	}
	input.RecurringPolicy, err = utilities.OptionalNullableJSON(input.RecurringPolicy)
	if err != nil {
		return ErrInvalidSpaceField
	}
	if input.AdmissionPolicy.Set {
		if input.AdmissionPolicy.Value == nil {
			return ErrInvalidAdmissionPolicy
		}
		input.AdmissionPolicy.Value, err = prepareAdmissionPolicy(input.AdmissionPolicy.Value)
		if err != nil {
			return err
		}
	}
	if input.RecordingPolicy.Set {
		if input.RecordingPolicy.Value == nil {
			return ErrInvalidRecordingPolicy
		}
		if err := input.RecordingPolicy.Value.Validate(); err != nil {
			return ErrInvalidRecordingPolicy
		}
	}
	if input.TranscriptionPolicy.Set {
		if input.TranscriptionPolicy.Value == nil {
			return ErrInvalidTranscriptionPolicy
		}
		if err := input.TranscriptionPolicy.Value.Validate(); err != nil {
			return ErrInvalidTranscriptionPolicy
		}
	}
	if err := validateOptionalDuration(input.DefaultEpisodeDurationSeconds, ErrInvalidEpisodeDuration); err != nil {
		return err
	}
	if err := validateOptionalDuration(input.MaximumEpisodeDurationSeconds, ErrInvalidEpisodeCeiling); err != nil {
		return err
	}
	if input.DefaultEpisodeDurationSeconds.Set && input.DefaultEpisodeDurationSeconds.Value == nil {
		return ErrInvalidEpisodeDuration
	}
	if input.MaximumEpisodeDurationSeconds.Set && input.MaximumEpisodeDurationSeconds.Value == nil {
		return ErrInvalidEpisodeCeiling
	}
	if input.DefaultEpisodeDurationSeconds.Set && input.MaximumEpisodeDurationSeconds.Set &&
		input.DefaultEpisodeDurationSeconds.Value != nil && input.MaximumEpisodeDurationSeconds.Value != nil &&
		*input.DefaultEpisodeDurationSeconds.Value > *input.MaximumEpisodeDurationSeconds.Value {
		return ErrInvalidEpisodeCeiling
	}
	if err := validateOptionalLingerWindow(input.LingerWindowSeconds); err != nil {
		return err
	}

	return nil
}

func prepareAdmissionPolicy(value json.RawMessage) (json.RawMessage, error) {
	value, err := utilities.JSON(value)
	if err != nil {
		return nil, ErrInvalidAdmissionPolicy
	}
	if len(value) == 0 {
		return append(json.RawMessage(nil), DefaultAdmissionPolicy...), nil
	}

	var decoded any
	if err := json.Unmarshal(value, &decoded); err != nil {
		return nil, ErrInvalidAdmissionPolicy
	}
	// The policy is intentionally stored as a document so the admission
	// boundary can add fields without a Space migration. The mode is required
	// by the database contract; preserve additional customer policy keys.
	policy, ok := decoded.(map[string]any)
	if !ok {
		return nil, ErrInvalidAdmissionPolicy
	}
	mode, present := policy["mode"]
	if !present {
		return nil, ErrInvalidAdmissionPolicy
	}
	modeValue, ok := mode.(string)
	if !ok || !validAdmissionMode(modeValue) {
		return nil, ErrInvalidAdmissionPolicy
	}
	return value, nil
}

func validAdmissionMode(mode string) bool {
	switch mode {
	case "open", "knock":
		return true
	default:
		return false
	}
}

func applySpaceDefaults(input *CreateSpaceInput) {
	if input.DefaultEpisodeDurationSeconds == 0 {
		input.DefaultEpisodeDurationSeconds = calllength.API.DefaultSeconds
	}
	if input.MaximumEpisodeDurationSeconds == 0 {
		input.MaximumEpisodeDurationSeconds = calllength.API.MaximumSeconds
	}
	if input.LingerWindowSeconds == 0 {
		input.LingerWindowSeconds = calllength.API.LingerSeconds
	}
}

func validateEpisodeDurations(defaultDuration, maximumDuration int32) error {
	if defaultDuration < calllength.MinimumSeconds || defaultDuration > calllength.MaximumSeconds {
		return ErrInvalidEpisodeDuration
	}
	if maximumDuration < calllength.MinimumSeconds || maximumDuration > calllength.MaximumSeconds || defaultDuration > maximumDuration {
		return ErrInvalidEpisodeCeiling
	}
	return nil
}

func validateOptionalDuration(value OptionalInt32, invalid error) error {
	if !value.Set || value.Value == nil {
		return nil
	}
	if *value.Value < calllength.MinimumSeconds || *value.Value > calllength.MaximumSeconds {
		return invalid
	}
	return nil
}

func validateLingerWindow(value int32) error {
	if value < 0 || value > calllength.MaximumSeconds {
		return ErrInvalidLingerWindow
	}
	return nil
}

func validateOptionalLingerWindow(value OptionalInt32) error {
	if !value.Set || value.Value == nil {
		if value.Set && value.Value == nil {
			return ErrInvalidLingerWindow
		}
		return nil
	}
	return validateLingerWindow(*value.Value)
}

func validateTenantSpaceIDs(tenantID utilities.ID, spaceID utilities.ID) error {
	if tenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if spaceID.IsZero() {
		return ErrInvalidSpaceID
	}
	return nil
}

func requiredOptionalString(value utilities.OptionalString, invalid error) (utilities.OptionalString, error) {
	if !value.Set {
		return value, nil
	}
	if value.Value == nil {
		return utilities.OptionalString{}, invalid
	}

	prepared, err := utilities.RequiredString(*value.Value)
	if err != nil {
		return utilities.OptionalString{}, invalid
	}

	return utilities.OptionalString{Set: true, Value: &prepared}, nil
}

type createFingerprintInput struct {
	Name                          string                             `json:"name"`
	Slug                          string                             `json:"slug"`
	MediaPlane                    string                             `json:"media_plane"`
	Metadata                      json.RawMessage                    `json:"metadata"`
	RecurringPolicy               json.RawMessage                    `json:"recurring_policy"`
	AdmissionPolicy               json.RawMessage                    `json:"admission_policy"`
	RecordingPolicy               artifactpolicy.RecordingMode       `json:"recording_policy"`
	RecordingPolicySet            bool                               `json:"recording_policy_set"`
	TranscriptLanguage            *artifactpolicy.TranscriptLanguage `json:"transcript_language,omitempty"`
	TranscriptionPolicy           artifactpolicy.TranscriptionMode   `json:"transcription_policy"`
	TranscriptionPolicySet        bool                               `json:"transcription_policy_set"`
	DefaultEpisodeDurationSeconds int32                              `json:"default_episode_duration_seconds"`
	MaximumEpisodeDurationSeconds int32                              `json:"maximum_episode_duration_seconds"`
	LingerWindowSeconds           int32                              `json:"linger_window_seconds"`
}

func createFingerprint(input CreateSpaceInput) ([32]byte, error) {
	payload, err := json.Marshal(createFingerprintInput{
		Name: input.Name, Slug: input.Slug, MediaPlane: input.MediaPlane,
		Metadata: input.Metadata, RecurringPolicy: input.RecurringPolicy, AdmissionPolicy: input.AdmissionPolicy,
		RecordingPolicy: input.RecordingPolicy, RecordingPolicySet: input.RecordingPolicySet,
		TranscriptionPolicy: input.TranscriptionPolicy, TranscriptionPolicySet: input.TranscriptionPolicySet,
		TranscriptLanguage:            input.TranscriptLanguage,
		DefaultEpisodeDurationSeconds: input.DefaultEpisodeDurationSeconds, MaximumEpisodeDurationSeconds: input.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds: input.LingerWindowSeconds,
	})
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(payload), nil
}

// setCreateFingerprints keeps old keys replayable even though both the stored
// default and the normalized request's default plane have changed.
func (input *CreateSpaceInput) setCreateFingerprints(recordingPolicySet, transcriptionPolicySet bool) error {
	fingerprint, err := createFingerprint(*input)
	if err != nil {
		return err
	}
	input.RequestFingerprint = fingerprint
	legacy := *input
	legacy.MediaPlane = mediaplane.PlaneCloudflare
	old, err := createFingerprint(legacy)
	if err != nil {
		return err
	}
	input.replayFingerprints = [][32]byte{old}
	if recordingPolicySet == input.RecordingPolicySet && transcriptionPolicySet == input.TranscriptionPolicySet {
		return nil
	}
	// Older deployments did not apply configured artifact defaults when a Space
	// inherited the platform media plane.
	if !recordingPolicySet {
		legacy.RecordingPolicy, legacy.RecordingPolicySet = artifactpolicy.RecordingDisabled, false
	}
	if !transcriptionPolicySet {
		legacy.TranscriptionPolicy, legacy.TranscriptionPolicySet = artifactpolicy.TranscriptionDisabled, false
	}
	old, err = createFingerprint(legacy)
	if err != nil {
		return err
	}
	input.replayFingerprints = append(input.replayFingerprints, old)
	return nil
}

func (input CreateSpaceInput) MatchesRequestFingerprint(stored []byte) bool {
	if bytes.Equal(stored, input.RequestFingerprint[:]) {
		return true
	}
	for _, fingerprint := range input.replayFingerprints {
		if bytes.Equal(stored, fingerprint[:]) {
			return true
		}
	}
	return false
}
