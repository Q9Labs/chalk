package media

import (
	"errors"
	"slices"
	"testing"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func TestKindOfFindsEachKindByItsWireNameAndRefusesOthers(t *testing.T) {
	for _, kind := range []*SessionKind{ParticipantSession, CaptureSession} {
		got, err := KindOf(kind.wire)
		if err != nil || got != kind {
			t.Fatalf("KindOf(%q) = %v, %v, want that kind", kind.wire, got, err)
		}
	}
	if _, err := KindOf("recorder"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("KindOf(unknown) error = %v, want ErrInvalidRequest", err)
	}
}

func TestReadinessListsACaptureKindOnlyWhileTheNodeCreatesIt(t *testing.T) {
	on := newTestNode(t, nil)
	if got := on.SessionKinds(); !slices.Equal(got, []string{protocol.SessionKindCapture}) {
		t.Fatalf("SessionKinds with captures on = %v, want the capture kind", got)
	}
	off := newTestNode(t, func(cfg *config.Config) { cfg.MaxCapturesPerEpisode = 0 })
	if got := off.SessionKinds(); len(got) != 0 {
		t.Fatalf("SessionKinds with captures off = %v, want none", got)
	}
}
