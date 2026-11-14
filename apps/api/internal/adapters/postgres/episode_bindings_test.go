package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type bindingRow struct{ provider, node *string }

func (r bindingRow) Scan(dest ...any) error {
	*dest[0].(**string), *dest[1].(**string) = r.provider, r.node
	return nil
}

type bindingDB struct{ row bindingRow }

func (d bindingDB) QueryRow(context.Context, string, ...any) pgx.Row { return d.row }

func TestCaptureSupportedFollowsTheOwnCaptureSwitch(t *testing.T) {
	cloudflare, own := "cloudflare_sfu", "chalk_sfu"
	for _, test := range []struct {
		name       string
		row        bindingRow
		ownCapture bool
		want       error
	}{
		{"Cloudflare Episode", bindingRow{provider: &cloudflare}, false, nil},
		{"Episode with no binding", bindingRow{}, false, nil},
		{"Chalk SFU Episode, capture off", bindingRow{provider: &own}, false, recordingpipeline.ErrCaptureUnsupported},
		{"Chalk SFU Episode, capture on", bindingRow{provider: &own}, true, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			bindings := NewEpisodeBindings(bindingDB{row: test.row}).WithOwnCapture(test.ownCapture)
			if err := bindings.CaptureSupported(t.Context(), utilities.ID{}, utilities.ID{}); !errors.Is(err, test.want) {
				t.Fatalf("CaptureSupported = %v, want %v", err, test.want)
			}
		})
	}
}
