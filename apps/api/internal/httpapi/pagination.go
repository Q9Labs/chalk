package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
)

type paginationResponse struct {
	PageSize   int     `json:"page_size"`
	NextCursor *string `json:"next_cursor"`
	HasMore    bool    `json:"has_more"`
}

func parsePageRequest(r *http.Request) (pagination.PageRequest, error) {
	values := r.URL.Query()
	size := pagination.DefaultPageSize

	if rawSize := strings.TrimSpace(values.Get("page_size")); rawSize != "" {
		parsedSize, err := strconv.Atoi(rawSize)
		if err != nil {
			return pagination.PageRequest{}, pagination.ErrInvalidPageSize
		}
		size = parsedSize
	}

	var cursor *pagination.Cursor
	if rawCursor := strings.TrimSpace(values.Get("cursor")); rawCursor != "" {
		decodedCursor, err := pagination.DecodeCursor(rawCursor)
		if err != nil {
			return pagination.PageRequest{}, err
		}
		cursor = &decodedCursor
	}

	return pagination.NewPageRequest(size, cursor)
}

func newPaginationResponse(page pagination.Page) (paginationResponse, error) {
	var nextCursor *string
	if page.NextCursor != nil {
		encodedCursor, err := pagination.EncodeCursor(*page.NextCursor)
		if err != nil {
			return paginationResponse{}, err
		}
		nextCursor = &encodedCursor
	}

	return paginationResponse{
		PageSize:   page.PageSize,
		NextCursor: nextCursor,
		HasMore:    page.HasMore,
	}, nil
}

func writePaginationError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, pagination.ErrInvalidPageSize):
		writeAPIError(w, apiErrorInvalidPageSize)
	case errors.Is(err, pagination.ErrInvalidCursor):
		writeAPIError(w, apiErrorInvalidCursor)
	default:
		writeAPIError(w, apiErrorInternal)
	}

	return true
}

func paginationAPIError(err error) APIError {
	switch {
	case errors.Is(err, pagination.ErrInvalidPageSize):
		return apiErrorInvalidPageSize
	case errors.Is(err, pagination.ErrInvalidCursor):
		return apiErrorInvalidCursor
	default:
		return apiErrorInternal
	}
}
