package control

import (
	"errors"
	"net/url"
	"testing"

	"github.com/q9labs/chalk/features/media/sfu/internal/media"
)

func TestProfileSeconds(t *testing.T) {
	for query, want := range map[string]int{"": maxProfileSeconds, "seconds=1": 1, "seconds=15": 15} {
		values, _ := url.ParseQuery(query)
		if got, err := profileSeconds(values); err != nil || got != want {
			t.Errorf("%q: got %d, %v; want %d", query, got, err, want)
		}
	}
	for _, query := range []string{"seconds=0", "seconds=16", "seconds=30", "seconds=-1", "seconds=abc"} {
		values, _ := url.ParseQuery(query)
		if _, err := profileSeconds(values); !errors.Is(err, media.ErrInvalidRequest) {
			t.Errorf("%q: error %v, want invalid request", query, err)
		}
	}
}
