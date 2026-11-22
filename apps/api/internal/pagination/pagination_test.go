package pagination

import (
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestCursorKeepsItsOrder(t *testing.T) {
	for _, order := range []string{"", "active"} {
		id, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := EncodeCursor(Cursor{CreatedAt: time.Now(), ID: id, Order: order})
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := DecodeCursor(encoded)
		if err != nil || decoded.Order != order {
			t.Errorf("a cursor of order %q came back as %q, %v", order, decoded.Order, err)
		}
	}
}
