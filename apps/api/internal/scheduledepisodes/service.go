// Package scheduledepisodes keeps the plan for a future Episode in a Space.
//
// A Scheduled Episode is an expectation: when a bounded run of activity is planned and who is
// expected. It is not an Episode. It never starts or ends one, admits anyone, or changes what a
// Space allows, and the clock never changes it.
package scheduledepisodes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	// MaximumDuration matches the longest Episode a Space can allow.
	MaximumDuration              = 7 * 24 * time.Hour
	MaximumExpectedParticipants  = 200
	MaximumParticipantNameBytes  = 256
	MaximumParticipantRoleBytes  = 128
	MaximumIdentityExternalBytes = 256
	MaximumMetadataBytes         = 8 * 1024

	// StatusScheduled is a booking that stands; StatusCancelled is one that was cancelled and stays so.
	StatusScheduled = "scheduled"
	StatusCancelled = "cancelled"
)

var (
	ErrInvalidTenantID             = errors.New("invalid tenant id")
	ErrInvalidSpaceID              = errors.New("invalid space id")
	ErrInvalidScheduledEpisodeID   = errors.New("invalid scheduled episode id")
	ErrInvalidSchedule             = errors.New("invalid schedule")
	ErrInvalidExpectedParticipants = errors.New("invalid expected participants")
	ErrInvalidMetadata             = errors.New("invalid metadata")
	ErrSpaceNotFound               = errors.New("space not found")
	ErrSpaceArchived               = errors.New("space archived")
	ErrNotFound                    = errors.New("scheduled episode not found")
	ErrCancelled                   = errors.New("scheduled episode cancelled")
)

// ExpectedParticipant is someone the plan expects. It is a note, never a grant: nobody gains access
// to a Space or an Episode by being named here.
type ExpectedParticipant struct {
	Name               string `json:"name"`
	Role               string `json:"role,omitempty"`
	IdentityExternalID string `json:"identity_external_id,omitempty"`
}

// Expectation is the full content of a booking. A write replaces all of it.
type Expectation struct {
	StartsAt             time.Time
	ExpectedEndsAt       time.Time
	ExpectedParticipants []ExpectedParticipant
	Metadata             json.RawMessage
}

type PutInput struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
	ID       utilities.ID
	Expectation
}

type ScheduledEpisode struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
	ID       utilities.ID
	Expectation
	CancelledAt *time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

func (s ScheduledEpisode) Status() string {
	if s.CancelledAt != nil {
		return StatusCancelled
	}
	return StatusScheduled
}

// Store keeps bookings. Every method qualifies by Tenant and Space, and the id is never reused for
// another Space. Put serializes with other writes to the same booking.
type Store interface {
	// Put creates the booking or replaces its expectation. It answers ErrSpaceNotFound for a Space
	// outside the Tenant, ErrSpaceArchived for an archived Space and ErrCancelled for a cancelled booking.
	Put(ctx context.Context, input PutInput) (ScheduledEpisode, error)
	// Get answers ErrNotFound for a booking that was never written, including one that only has a tombstone.
	Get(ctx context.Context, tenantID, spaceID, id utilities.ID) (ScheduledEpisode, error)
	// Cancel is idempotent and also records a tombstone for an id that was never written.
	Cancel(ctx context.Context, tenantID, spaceID, id utilities.ID) error
}

type Service struct {
	store Store
}

func NewService(store Store) *Service {
	return &Service{store: store}
}

func (s *Service) Put(ctx context.Context, input PutInput) (ScheduledEpisode, error) {
	if err := validateIDs(input.TenantID, input.SpaceID, input.ID); err != nil {
		return ScheduledEpisode{}, err
	}
	expectation, err := prepareExpectation(input.Expectation)
	if err != nil {
		return ScheduledEpisode{}, err
	}
	input.Expectation = expectation
	return s.store.Put(ctx, input)
}

func (s *Service) Get(ctx context.Context, tenantID, spaceID, id utilities.ID) (ScheduledEpisode, error) {
	if err := validateIDs(tenantID, spaceID, id); err != nil {
		return ScheduledEpisode{}, err
	}
	return s.store.Get(ctx, tenantID, spaceID, id)
}

func (s *Service) Cancel(ctx context.Context, tenantID, spaceID, id utilities.ID) error {
	if err := validateIDs(tenantID, spaceID, id); err != nil {
		return err
	}
	return s.store.Cancel(ctx, tenantID, spaceID, id)
}

func validateIDs(tenantID, spaceID, id utilities.ID) error {
	switch {
	case tenantID.IsZero():
		return ErrInvalidTenantID
	case spaceID.IsZero():
		return ErrInvalidSpaceID
	case id.IsZero():
		return ErrInvalidScheduledEpisodeID
	}
	return nil
}

// prepareExpectation normalizes times to UTC at the precision the store keeps, then checks the plan.
// It never compares a time with the clock, so a late retry of an old plan is judged like a fresh one.
func prepareExpectation(expectation Expectation) (Expectation, error) {
	if expectation.StartsAt.IsZero() || expectation.ExpectedEndsAt.IsZero() {
		return Expectation{}, ErrInvalidSchedule
	}
	expectation.StartsAt = expectation.StartsAt.UTC().Truncate(time.Microsecond)
	expectation.ExpectedEndsAt = expectation.ExpectedEndsAt.UTC().Truncate(time.Microsecond)
	duration := expectation.ExpectedEndsAt.Sub(expectation.StartsAt)
	if duration <= 0 || duration > MaximumDuration {
		return Expectation{}, ErrInvalidSchedule
	}

	participants, err := prepareParticipants(expectation.ExpectedParticipants)
	if err != nil {
		return Expectation{}, err
	}
	expectation.ExpectedParticipants = participants

	metadata, err := prepareMetadata(expectation.Metadata)
	if err != nil {
		return Expectation{}, err
	}
	expectation.Metadata = metadata
	return expectation, nil
}

func prepareParticipants(participants []ExpectedParticipant) ([]ExpectedParticipant, error) {
	if len(participants) > MaximumExpectedParticipants {
		return nil, ErrInvalidExpectedParticipants
	}
	prepared := make([]ExpectedParticipant, 0, len(participants))
	seen := make(map[string]struct{}, len(participants))
	for _, participant := range participants {
		name, role, identity := strings.TrimSpace(participant.Name), strings.TrimSpace(participant.Role), strings.TrimSpace(participant.IdentityExternalID)
		if name == "" || !validText(name, MaximumParticipantNameBytes) || !validText(role, MaximumParticipantRoleBytes) || !validText(identity, MaximumIdentityExternalBytes) {
			return nil, ErrInvalidExpectedParticipants
		}
		if identity != "" {
			if _, duplicate := seen[identity]; duplicate {
				return nil, ErrInvalidExpectedParticipants
			}
			seen[identity] = struct{}{}
		}
		prepared = append(prepared, ExpectedParticipant{Name: name, Role: role, IdentityExternalID: identity})
	}
	return prepared, nil
}

func validText(value string, limit int) bool {
	return utf8.ValidString(value) && len(value) <= limit && strings.IndexByte(value, 0) < 0
}

// prepareMetadata accepts nothing or one JSON object. Absent and null both mean no metadata.
func prepareMetadata(metadata json.RawMessage) (json.RawMessage, error) {
	if len(metadata) == 0 {
		return nil, nil
	}
	if len(metadata) > MaximumMetadataBytes {
		return nil, ErrInvalidMetadata
	}
	compact := bytes.TrimSpace(metadata)
	if len(compact) == 0 || compact[0] != '{' || !json.Valid(compact) {
		return nil, ErrInvalidMetadata
	}
	// JSONB expands scientific notation. Bound the aggregate growth before
	// asking Postgres to materialize the plan, without rounding its numbers.
	remaining := MaximumMetadataBytes - len(metadata)
	decoder := json.NewDecoder(bytes.NewReader(compact))
	decoder.UseNumber()
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return metadata, nil
		}
		if err != nil {
			return nil, ErrInvalidMetadata
		}
		number, ok := token.(json.Number)
		if !ok {
			continue
		}
		exponent := strings.IndexAny(number.String(), "eE")
		if exponent < 0 {
			continue
		}
		shift, err := strconv.Atoi(number.String()[exponent+1:])
		if err != nil || shift > remaining || shift < -remaining {
			return nil, ErrInvalidMetadata
		}
		remaining -= max(shift, -shift)
	}
}
