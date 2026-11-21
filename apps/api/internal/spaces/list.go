package spaces

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// ListOrder is the order a list of Spaces comes in.
type ListOrder string

const (
	// ListOrderCreated lists the newest Space first. A page's cursor holds the last Space's creation time.
	ListOrderCreated ListOrder = "created"
	// ListOrderActive lists the most recently active Space first: the latest of its creation and its Episodes'
	// creation, start and end. A page's cursor holds the last Space's activity time, so a Space that becomes active
	// while a person pages moves to the first page instead of turning up again on a later one.
	ListOrderActive ListOrder = "active"
)

// CursorOrder is what a page's cursor records of the order, so a cursor only continues the list it came from.
// Created is the default order and records nothing, which keeps cursors issued before orders existed valid.
func (o ListOrder) CursorOrder() string {
	if o == ListOrderActive {
		return string(ListOrderActive)
	}
	return ""
}

// checkCursor refuses a cursor taken from a list in another order: its position means something else here, so
// continuing from it would skip or repeat Spaces without saying so.
func checkCursor(page pagination.PageRequest, order ListOrder) error {
	if cursor := page.Cursor(); cursor != nil && cursor.Order != order.CursorOrder() {
		return pagination.ErrInvalidCursor
	}
	return nil
}

// ListOptions narrows and orders a list of Spaces. The zero value lists every Space, newest first.
type ListOptions struct {
	Archived *bool
	Order    ListOrder
}

func (s Service) ListSpaces(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (SpaceList, error) {
	if tenantID.IsZero() {
		return SpaceList{}, ErrInvalidTenantID
	}
	if err := checkCursor(page, ListOrderCreated); err != nil {
		return SpaceList{}, err
	}

	return s.repository.ListSpaces(ctx, tenantID, page)
}

func (s Service) ListSpacesFiltered(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest, options ListOptions) (SpaceList, error) {
	if tenantID.IsZero() {
		return SpaceList{}, ErrInvalidTenantID
	}
	if err := checkCursor(page, options.Order); err != nil {
		return SpaceList{}, err
	}
	filtered, ok := s.repository.(FilteredRepository)
	if !ok || options == (ListOptions{}) {
		return s.repository.ListSpaces(ctx, tenantID, page)
	}
	return filtered.ListSpacesFiltered(ctx, tenantID, page, options)
}
