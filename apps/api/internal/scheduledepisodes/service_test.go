package scheduledepisodes

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingStore struct {
	put   PutInput
	calls int
}

func (s *recordingStore) Put(_ context.Context, input PutInput) (ScheduledEpisode, error) {
	s.put, s.calls = input, s.calls+1
	return ScheduledEpisode{}, nil
}

func (s *recordingStore) Get(context.Context, utilities.ID, utilities.ID, utilities.ID) (ScheduledEpisode, error) {
	s.calls++
	return ScheduledEpisode{}, nil
}

func (s *recordingStore) Cancel(context.Context, utilities.ID, utilities.ID, utilities.ID) error {
	s.calls++
	return nil
}

func newTestID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func validInput(t *testing.T) PutInput {
	t.Helper()
	start := time.Date(2027, 3, 1, 10, 0, 0, 0, time.UTC)
	return PutInput{
		TenantID: newTestID(t), SpaceID: newTestID(t), ID: newTestID(t),
		Expectation: Expectation{StartsAt: start, ExpectedEndsAt: start.Add(time.Hour)},
	}
}

func TestPutValidatesThePlanWithoutLookingAtTheClock(t *testing.T) {
	long := strings.Repeat("x", 300)
	tooMany := make([]ExpectedParticipant, MaximumExpectedParticipants+1)
	for i := range tooMany {
		tooMany[i] = ExpectedParticipant{Name: "Guest"}
	}
	for _, tc := range []struct {
		name   string
		change func(*PutInput)
		want   error
	}{
		{"a plan entirely in the past is as good as a future one", func(in *PutInput) {
			in.StartsAt = time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)
			in.ExpectedEndsAt = in.StartsAt.Add(time.Minute)
		}, nil},
		{"an offset start is the same instant in UTC", func(in *PutInput) {
			in.StartsAt = in.StartsAt.In(time.FixedZone("UTC+4", 4*3600))
		}, nil},
		{"the longest allowed plan", func(in *PutInput) { in.ExpectedEndsAt = in.StartsAt.Add(MaximumDuration) }, nil},
		{"no start", func(in *PutInput) { in.StartsAt = time.Time{} }, ErrInvalidSchedule},
		{"no end", func(in *PutInput) { in.ExpectedEndsAt = time.Time{} }, ErrInvalidSchedule},
		{"the end equals the start", func(in *PutInput) { in.ExpectedEndsAt = in.StartsAt }, ErrInvalidSchedule},
		{"the end is before the start", func(in *PutInput) { in.ExpectedEndsAt = in.StartsAt.Add(-time.Second) }, ErrInvalidSchedule},
		{"the end is less than a microsecond after the start", func(in *PutInput) { in.ExpectedEndsAt = in.StartsAt.Add(time.Nanosecond) }, ErrInvalidSchedule},
		{"longer than a Space allows", func(in *PutInput) { in.ExpectedEndsAt = in.StartsAt.Add(MaximumDuration + time.Second) }, ErrInvalidSchedule},
		{"a participant without a name", func(in *PutInput) { in.ExpectedParticipants = []ExpectedParticipant{{Name: "  "}} }, ErrInvalidExpectedParticipants},
		{"a participant name that is too long", func(in *PutInput) { in.ExpectedParticipants = []ExpectedParticipant{{Name: long}} }, ErrInvalidExpectedParticipants},
		{"a role that is too long", func(in *PutInput) {
			in.ExpectedParticipants = []ExpectedParticipant{{Name: "Ada", Role: strings.Repeat("r", 129)}}
		}, ErrInvalidExpectedParticipants},
		{"the same identity twice", func(in *PutInput) {
			in.ExpectedParticipants = []ExpectedParticipant{{Name: "Ada", IdentityExternalID: "a"}, {Name: "Ada again", IdentityExternalID: "a"}}
		}, ErrInvalidExpectedParticipants},
		{"the same name twice without identities", func(in *PutInput) {
			in.ExpectedParticipants = []ExpectedParticipant{{Name: "Guest"}, {Name: "Guest"}}
		}, nil},
		{"too many participants", func(in *PutInput) { in.ExpectedParticipants = tooMany }, ErrInvalidExpectedParticipants},
		{"metadata that is not an object", func(in *PutInput) { in.Metadata = json.RawMessage(`[1]`) }, ErrInvalidMetadata},
		{"metadata that is null text", func(in *PutInput) { in.Metadata = json.RawMessage(`null`) }, ErrInvalidMetadata},
		{"metadata that is too large", func(in *PutInput) {
			in.Metadata = json.RawMessage(`{"k":"` + strings.Repeat("v", MaximumMetadataBytes) + `"}`)
		}, ErrInvalidMetadata},
		{"no tenant", func(in *PutInput) { in.TenantID = utilities.ID{} }, ErrInvalidTenantID},
		{"no space", func(in *PutInput) { in.SpaceID = utilities.ID{} }, ErrInvalidSpaceID},
		{"no booking id", func(in *PutInput) { in.ID = utilities.ID{} }, ErrInvalidScheduledEpisodeID},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &recordingStore{}
			input := validInput(t)
			tc.change(&input)
			_, err := NewService(store).Put(context.Background(), input)
			if !errors.Is(err, tc.want) {
				t.Fatalf("Put error = %v, want %v", err, tc.want)
			}
			if (tc.want == nil) != (store.calls == 1) {
				t.Fatalf("store calls = %d for error %v", store.calls, err)
			}
		})
	}
}

func TestPutHandsTheStoreANormalizedPlan(t *testing.T) {
	store := &recordingStore{}
	input := validInput(t)
	input.StartsAt = time.Date(2027, 3, 1, 14, 0, 0, 123456789, time.FixedZone("UTC+4", 4*3600))
	input.ExpectedEndsAt = input.StartsAt.Add(time.Hour)
	input.ExpectedParticipants = []ExpectedParticipant{{Name: " Ada ", Role: " host ", IdentityExternalID: " ada-1 "}}
	if _, err := NewService(store).Put(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	got := store.put
	if got.StartsAt.Location() != time.UTC || got.StartsAt.Nanosecond() != 123456000 {
		t.Fatalf("starts_at = %v, want UTC truncated to microseconds", got.StartsAt)
	}
	if want := (ExpectedParticipant{Name: "Ada", Role: "host", IdentityExternalID: "ada-1"}); got.ExpectedParticipants[0] != want {
		t.Fatalf("participant = %+v, want %+v", got.ExpectedParticipants[0], want)
	}
	if got.ExpectedParticipants == nil || got.Metadata != nil {
		t.Fatalf("expectation = %+v, want an empty participant list kept as a list and no metadata", got)
	}
}

func TestGetAndCancelNeedWholeIdentity(t *testing.T) {
	store := &recordingStore{}
	service := NewService(store)
	id := newTestID(t)
	if _, err := service.Get(context.Background(), id, utilities.ID{}, id); !errors.Is(err, ErrInvalidSpaceID) {
		t.Fatalf("Get error = %v", err)
	}
	if err := service.Cancel(context.Background(), utilities.ID{}, id, id); !errors.Is(err, ErrInvalidTenantID) {
		t.Fatalf("Cancel error = %v", err)
	}
	if store.calls != 0 {
		t.Fatal("an unqualified request reached the store")
	}
}
