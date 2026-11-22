package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r SpaceRepository) ListSpaces(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (spaces.SpaceList, error) {
	return r.ListSpacesFiltered(ctx, tenantID, page, spaces.ListOptions{})
}

func (r SpaceRepository) ListSpacesFiltered(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest, options spaces.ListOptions) (spaces.SpaceList, error) {
	// Each row comes with the time its order sorts by, which a next page's cursor carries.
	var rows []spaceListRow
	if options.Order == spaces.ListOrderActive {
		found, err := r.queries.ListTenantSpacesByActivity(ctx, listTenantSpacesByActivityParams(tenantID, page, options.Archived))
		if err != nil {
			return spaces.SpaceList{}, fmt.Errorf("list spaces by activity: %w", err)
		}
		for _, row := range found {
			rows = append(rows, spaceListRow{space: row.Space, sortedAt: row.ActiveAt.Time})
		}
	} else {
		found, err := r.queries.ListTenantSpaces(ctx, listTenantSpacesParams(tenantID, page, options.Archived))
		if err != nil {
			return spaces.SpaceList{}, fmt.Errorf("list spaces: %w", err)
		}
		for _, row := range found {
			rows = append(rows, spaceListRow{space: row, sortedAt: row.CreatedAt.Time})
		}
	}

	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}

	list := spaces.SpaceList{
		Spaces: make([]spaces.Space, 0, len(rows)),
		Page:   pagination.Page{PageSize: size, HasMore: hasMore},
	}
	for _, row := range rows {
		space, err := r.withSpaceRoles(ctx, mapSpace(row.space))
		if err != nil {
			return spaces.SpaceList{}, err
		}
		list.Spaces = append(list.Spaces, space)
	}
	if hasMore && len(rows) > 0 {
		last := rows[len(rows)-1]
		list.Page.NextCursor = &pagination.Cursor{CreatedAt: last.sortedAt, ID: utilities.IDFromBytes(last.space.ID.Bytes), Order: options.Order.CursorOrder()}
	}

	return list, nil
}

type spaceListRow struct {
	space    sqlc.Space
	sortedAt time.Time
}
