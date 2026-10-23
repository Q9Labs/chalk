package problemreports

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type attributionRepository struct{}

func (attributionRepository) Attribution(context.Context, accessgrants.Subject) (Attribution, error) {
	return Attribution{SpaceName: "Private call", ReporterName: "Reporter person@example.com", Role: "guest"}, nil
}

type deliveryPort struct {
	err    error
	report Delivery
}

func (p *deliveryPort) Send(_ context.Context, report Delivery) error {
	p.report = report
	return p.err
}

type evidenceRepository struct {
	attributionRepository
	recorded []utilities.ID
	err      error
}

func (r *evidenceRepository) RecordDelivery(_ context.Context, _ accessgrants.Subject, reportID utilities.ID) error {
	r.recorded = append(r.recorded, reportID)
	return r.err
}
func TestDeliveryAndJourneyResults(t *testing.T) {
	ctx := context.Background()
	repository, sender := &evidenceRepository{}, &deliveryPort{}
	service := NewService(repository, sender)
	report := Report{Description: "Private report", Diagnostics: "Private diagnostics"}
	result, err := service.Send(ctx, accessgrants.Subject{}, report)
	if err != nil || result.Outcome != OutcomeAccepted || result.ReportID.IsZero() || len(repository.recorded) != 1 || sender.report.Report != report {
		t.Fatal("accepted result lost delivery or journey evidence")
	}
	repository.err = context.DeadlineExceeded
	result, err = service.Send(ctx, accessgrants.Subject{}, report)
	if err != nil || result.Outcome != OutcomeJourneyTimeout || result.ReportID.IsZero() {
		t.Fatal("accepted delivery with lost journey evidence must have its own non-retrying outcome")
	}
	sender.err = ErrDelivery
	result, err = service.Send(ctx, accessgrants.Subject{}, report)
	if !errors.Is(err, ErrDelivery) || result.Outcome != OutcomeDiscordFailed || len(repository.recorded) != 2 {
		t.Fatal("failed delivery changed journey evidence")
	}
}

func (attributionRepository) RecordDelivery(context.Context, accessgrants.Subject, utilities.ID) error {
	return nil
}

type namedAttributionRepository struct {
	attributionRepository
	name Attribution
}

func (r namedAttributionRepository) Attribution(context.Context, accessgrants.Subject) (Attribution, error) {
	return r.name, nil
}
func TestReportsFromOrdinaryNames(t *testing.T) {
	for _, name := range []Attribution{
		{SpaceName: "New Call", ReporterName: "Casey Jones", Role: "guest"},
		{SpaceName: "New Call", ReporterName: "Hailey Jones", Role: "owner"},
		{SpaceName: "Casey Jones", ReporterName: "Reporter", Role: "guest"},
	} {
		sender := &deliveryPort{}
		service := NewService(namedAttributionRepository{name: name}, sender)
		report := Report{Description: "My camera stopped working after reconnecting to the call."}
		if _, err := service.Send(context.Background(), accessgrants.Subject{}, report); err != nil {
			t.Errorf("ordinary name rejected: %v", err)
		}
		if sender.report.Report != report {
			t.Error("ordinary description did not reach delivery")
		}

	}
}
