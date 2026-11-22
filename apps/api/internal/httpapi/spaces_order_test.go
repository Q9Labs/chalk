package httpapi

import (
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

func TestSpaceOrderQueryKeepsNewestFirstUnlessAskedForActivity(t *testing.T) {
	for _, test := range []struct {
		query string
		want  spaces.ListOrder
		err   error
	}{
		{"", "", nil},
		{"?order=created", "", nil},
		{"?order=active", spaces.ListOrderActive, nil},
		{"?order=recent", "", apiErrorInvalidSpaceOrder},
	} {
		got, err := spaceOrderQuery(httptest.NewRequest("GET", "/v1/tenants/x/spaces"+test.query, nil))
		if got != test.want || !errors.Is(err, test.err) {
			t.Errorf("order from %q = %q, %v; want %q, %v", test.query, got, err, test.want, test.err)
		}
	}
}
