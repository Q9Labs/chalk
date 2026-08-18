package spaces

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidSpaceID         = errors.New("invalid space id")
	ErrInvalidTenantID        = errors.New("invalid tenant id")
	ErrInvalidSpaceName       = errors.New("invalid space name")
	ErrInvalidSpaceSlug       = errors.New("invalid space slug")
	ErrInvalidMediaPlane      = errors.New("invalid media plane")
	ErrInvalidAdmissionPolicy = errors.New("invalid admission policy")
	ErrInvalidEpisodeDuration = errors.New("invalid episode duration")
	ErrInvalidEpisodeCeiling  = errors.New("invalid episode duration ceiling")
	ErrInvalidLingerWindow    = errors.New("invalid linger window")
	ErrInvalidSpaceField      = errors.New("invalid space field")
	ErrSpaceNotFound          = errors.New("space not found")
	ErrSpaceSlugAlreadyUsed   = errors.New("space slug already used")
	ErrInvalidRequestKey      = errors.New("invalid space request key")
	ErrIdempotencyConflict    = errors.New("space request key conflicts with original request")
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
	ID                            utilities.ID
	Name                          string
	TenantID                      utilities.ID
	Slug                          string
	MediaPlane                    string
	Metadata                      json.RawMessage
	RecurringPolicy               json.RawMessage
	AdmissionPolicy               json.RawMessage
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

type Service struct {
	repository        Repository
	defaultMediaPlane MediaPlaneProvider
}

type CreateSpaceInput struct {
	ID                            utilities.ID
	Name                          string
	TenantID                      utilities.ID
	Slug                          string
	MediaPlane                    string
	MediaPlaneSet                 bool
	Metadata                      json.RawMessage
	RecurringPolicy               json.RawMessage
	AdmissionPolicy               json.RawMessage
	DefaultEpisodeDurationSeconds int32
	MaximumEpisodeDurationSeconds int32
	LingerWindowSeconds           int32
	CreatedByUserID               utilities.ID
	RequestKey                    string
	RequestFingerprint            [32]byte
}

type UpdateSpaceInput struct {
	Name                          utilities.OptionalString
	Slug                          utilities.OptionalString
	MediaPlane                    utilities.OptionalString
	Metadata                      utilities.OptionalJSON
	RecurringPolicy               utilities.OptionalJSON
	AdmissionPolicy               utilities.OptionalJSON
	DefaultEpisodeDurationSeconds OptionalInt32
	MaximumEpisodeDurationSeconds OptionalInt32
	LingerWindowSeconds           OptionalInt32
}

// OptionalInt32 preserves omitted, explicit null, and concrete numeric JSON
// values for PATCH requests without leaking database nullable types into the
// service package.
type OptionalInt32 struct {
	Set   bool
	Value *int32
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

func NewServiceWithDefaultProvider(repository Repository, defaultProvider MediaPlaneProvider) Service {
	return Service{repository: repository, defaultMediaPlane: defaultProvider}
}

func (s Service) CreateSpace(ctx context.Context, input CreateSpaceInput) (Space, error) {
	id, err := utilities.NewID()
	if err != nil {
		return Space{}, err
	}
	input.ID = id
	if !input.MediaPlaneSet && input.MediaPlane == "" && s.defaultMediaPlane != "" {
		input.MediaPlane = string(s.defaultMediaPlane)
	}
	if err := prepareCreateSpaceInput(&input); err != nil {
		return Space{}, err
	}
	if input.RequestKey != "" {
		if !spaceRequestKeyPattern.MatchString(input.RequestKey) {
			return Space{}, ErrInvalidRequestKey
		}
		fingerprint, err := createFingerprint(input)
		if err != nil {
			return Space{}, err
		}
		input.RequestFingerprint = fingerprint
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

func (s Service) ListSpaces(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (SpaceList, error) {
	if tenantID.IsZero() {
		return SpaceList{}, ErrInvalidTenantID
	}

	return s.repository.ListSpaces(ctx, tenantID, page)
}

func (s Service) ListSpacesFiltered(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest, archived *bool) (SpaceList, error) {
	if tenantID.IsZero() {
		return SpaceList{}, ErrInvalidTenantID
	}
	filtered, ok := s.repository.(FilteredRepository)
	if !ok || archived == nil {
		return s.repository.ListSpaces(ctx, tenantID, page)
	}
	return filtered.ListSpacesFiltered(ctx, tenantID, page, archived)
}

func (s Service) UpdateSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID, input UpdateSpaceInput) (Space, error) {
	if err := validateTenantSpaceIDs(tenantID, spaceID); err != nil {
		return Space{}, err
	}
	if err := prepareUpdateSpaceInput(&input); err != nil {
		return Space{}, err
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
	if err != nil {
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
	provider, err := ParseMediaPlaneProvider(mediaPlane)
	if err != nil {
		return ErrInvalidMediaPlane
	}
	input.MediaPlane = string(provider)

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

	input.Name, err = requiredOptionalString(input.Name, ErrInvalidSpaceName)
	if err != nil {
		return err
	}
	input.Slug, err = requiredOptionalString(input.Slug, ErrInvalidSpaceSlug)
	if err != nil {
		return err
	}
	input.MediaPlane, err = requiredOptionalString(input.MediaPlane, ErrInvalidMediaPlane)
	if err != nil {
		return err
	}
	if input.MediaPlane.Set {
		provider, parseErr := ParseMediaPlaneProvider(*input.MediaPlane.Value)
		if parseErr != nil {
			return ErrInvalidMediaPlane
		}
		value := string(provider)
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
	case "open", "knock", "members_only":
		return true
	default:
		return false
	}
}

func applySpaceDefaults(input *CreateSpaceInput) {
	if input.DefaultEpisodeDurationSeconds == 0 {
		input.DefaultEpisodeDurationSeconds = DefaultEpisodeDurationSeconds
	}
	if input.MaximumEpisodeDurationSeconds == 0 {
		input.MaximumEpisodeDurationSeconds = DefaultMaximumEpisodeDurationSeconds
	}
	if input.LingerWindowSeconds == 0 {
		input.LingerWindowSeconds = DefaultLingerWindowSeconds
	}
}

func validateEpisodeDurations(defaultDuration, maximumDuration int32) error {
	if defaultDuration < MinimumEpisodeDurationSeconds || defaultDuration > MaximumEpisodeDurationSeconds {
		return ErrInvalidEpisodeDuration
	}
	if maximumDuration < MinimumEpisodeDurationSeconds || maximumDuration > MaximumEpisodeDurationSeconds || defaultDuration > maximumDuration {
		return ErrInvalidEpisodeCeiling
	}
	return nil
}

func validateOptionalDuration(value OptionalInt32, invalid error) error {
	if !value.Set || value.Value == nil {
		return nil
	}
	if *value.Value < MinimumEpisodeDurationSeconds || *value.Value > MaximumEpisodeDurationSeconds {
		return invalid
	}
	return nil
}

func validateLingerWindow(value int32) error {
	if value < 0 || value > MaximumEpisodeDurationSeconds {
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
	Name                          string          `json:"name"`
	Slug                          string          `json:"slug"`
	MediaPlane                    string          `json:"media_plane"`
	Metadata                      json.RawMessage `json:"metadata"`
	RecurringPolicy               json.RawMessage `json:"recurring_policy"`
	AdmissionPolicy               json.RawMessage `json:"admission_policy"`
	DefaultEpisodeDurationSeconds int32           `json:"default_episode_duration_seconds"`
	MaximumEpisodeDurationSeconds int32           `json:"maximum_episode_duration_seconds"`
	LingerWindowSeconds           int32           `json:"linger_window_seconds"`
}

func createFingerprint(input CreateSpaceInput) ([32]byte, error) {
	payload, err := json.Marshal(createFingerprintInput{
		Name: input.Name, Slug: input.Slug, MediaPlane: input.MediaPlane,
		Metadata: input.Metadata, RecurringPolicy: input.RecurringPolicy, AdmissionPolicy: input.AdmissionPolicy,
		DefaultEpisodeDurationSeconds: input.DefaultEpisodeDurationSeconds, MaximumEpisodeDurationSeconds: input.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds: input.LingerWindowSeconds,
	})
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(payload), nil
}
