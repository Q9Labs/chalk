package spaces

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func newID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// listRepository answers only the list calls, and records that one reached it.
type listRepository struct {
	Repository
	listed bool
}

func (r *listRepository) ListSpaces(context.Context, utilities.ID, pagination.PageRequest) (SpaceList, error) {
	r.listed = true
	return SpaceList{}, nil
}

func (r *listRepository) ListSpacesFiltered(context.Context, utilities.ID, pagination.PageRequest, ListOptions) (SpaceList, error) {
	r.listed = true
	return SpaceList{}, nil
}

func TestListRefusesACursorFromAnotherOrder(t *testing.T) {
	tenant := newID(t)
	cursorOf := func(order ListOrder) pagination.PageRequest {
		page, err := pagination.NewPageRequest(5, &pagination.Cursor{CreatedAt: time.Now(), ID: newID(t), Order: order.CursorOrder()})
		if err != nil {
			t.Fatal(err)
		}
		return page
	}
	for _, test := range []struct {
		name   string
		cursor ListOrder
		list   ListOrder
		want   error
	}{
		{"created cursor on the created list", ListOrderCreated, ListOrderCreated, nil},
		{"active cursor on the active list", ListOrderActive, ListOrderActive, nil},
		{"active cursor on the default list", ListOrderActive, "", pagination.ErrInvalidCursor},
		// A cursor with no recorded order was made by the created list, so its position is a creation time and means nothing in the activity order.
		{"created cursor (or one from before orders) on the active list", ListOrderCreated, ListOrderActive, pagination.ErrInvalidCursor},
		{"active cursor on the created list", ListOrderActive, ListOrderCreated, pagination.ErrInvalidCursor},
	} {
		repository := &listRepository{}
		service := Service{repository: repository}
		_, err := service.ListSpacesFiltered(context.Background(), tenant, cursorOf(test.cursor), ListOptions{Order: test.list})
		if !errors.Is(err, test.want) || repository.listed != (test.want == nil) {
			t.Errorf("%s: error %v, reached the repository %v; want error %v", test.name, err, repository.listed, test.want)
		}
	}
}

func TestListSpacesRefusesAnActivityCursor(t *testing.T) {
	page, err := pagination.NewPageRequest(5, &pagination.Cursor{CreatedAt: time.Now(), ID: newID(t), Order: string(ListOrderActive)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (Service{repository: &listRepository{}}).ListSpaces(context.Background(), newID(t), page); !errors.Is(err, pagination.ErrInvalidCursor) {
		t.Errorf("an activity cursor on the older list method gave %v; want an invalid cursor", err)
	}
}
