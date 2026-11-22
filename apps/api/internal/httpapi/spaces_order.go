package httpapi

import (
	"net/http"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

func spaceOrderParameter() APIParameterContract {
	return APIParameterContract{Name: "order", In: "query", Type: "string", Required: false, Enum: []string{string(spaces.ListOrderCreated), string(spaces.ListOrderActive)}}
}

// spaceOrderQuery reads `order`. Leaving it out or asking for `created` keeps the newest-first order older callers rely on.
func spaceOrderQuery(r *http.Request) (spaces.ListOrder, error) {
	switch raw := strings.TrimSpace(r.URL.Query().Get("order")); spaces.ListOrder(raw) {
	case "", spaces.ListOrderCreated:
		return "", nil
	case spaces.ListOrderActive:
		return spaces.ListOrderActive, nil
	default:
		return "", apiErrorInvalidSpaceOrder
	}
}
