package episodes

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type activityRepository struct {
	Repository
	calls int
}

func (r *activityRepository) ListSpaceActivity(_ context.Context, _ utilities.ID, ids []utilities.ID) ([]SpaceActivity, error) {
	r.calls++
	return []SpaceActivity{{SpaceID: ids[0]}}, nil
}

func TestListSpaceActivityValidation(t *testing.T) {
	tenant, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]utilities.ID, MaximumActivitySpaces+1)
	for i := range ids {
		ids[i], err = utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct {
		name   string
		tenant utilities.ID
		ids    []utilities.ID
		want   error
	}{
		{"empty tenant", utilities.ID{}, ids[:1], ErrInvalidTenantID},
		{"empty list", tenant, nil, ErrInvalidActivitySpaceIDs},
		{"301 IDs", tenant, ids, ErrInvalidActivitySpaceIDs},
		{"duplicate", tenant, []utilities.ID{ids[0], ids[0]}, ErrInvalidActivitySpaceIDs},
		{"zero ID", tenant, []utilities.ID{{}}, ErrInvalidActivitySpaceIDs},
		{"300 IDs", tenant, ids[:MaximumActivitySpaces], nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := &activityRepository{}
			_, err := NewService(repository).ListSpaceActivity(context.Background(), test.tenant, test.ids)
			if !errors.Is(err, test.want) {
				t.Fatalf("error=%v want=%v", err, test.want)
			}
			wantCalls := 0
			if test.want == nil {
				wantCalls = 1
			}
			if repository.calls != wantCalls {
				t.Fatalf("repository calls=%d want=%d", repository.calls, wantCalls)
			}
		})
	}
}
