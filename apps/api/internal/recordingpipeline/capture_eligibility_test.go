package recordingpipeline

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type eligibilityStub struct {
	err   error
	calls int
}

func (e *eligibilityStub) CaptureSupported(context.Context, utilities.ID, utilities.ID) error {
	e.calls++
	return e.err
}

// An Episode whose media plane cannot be captured is refused before any
// capacity is reserved: the nil repository would panic on a reservation.
func TestReserveRefusesAnUncapturableEpisodeBeforeReserving(t *testing.T) {
	unsupported := errors.New("capture unsupported")
	for name, reserve := range map[string]func(Service) error{
		"reserve": func(s Service) error { _, err := s.Reserve(context.Background(), ReservationInput{}); return err },
		"materialize": func(s Service) error {
			_, err := s.Materialize(context.Background(), ReservationInput{})
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			eligibility := &eligibilityStub{err: unsupported}
			err := reserve(NewService(nil).WithCaptureEligibility(eligibility))
			if !errors.Is(err, unsupported) || eligibility.calls != 1 {
				t.Fatalf("err = %v, eligibility calls = %d", err, eligibility.calls)
			}
		})
	}
}
