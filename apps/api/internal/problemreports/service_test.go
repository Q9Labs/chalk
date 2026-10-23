package problemreports

import (
	"context"
	"errors"
	"fmt"
	"strings"
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
func TestReportRejectsCredentialsInNames(t *testing.T) {
	code := strings.Repeat("ab09\u200b", 20)
	for _, name := range []Attribution{{SpaceName: code, ReporterName: "Tester", Role: "guest"}, {SpaceName: "New Call", ReporterName: code, Role: "guest"}} {
		sender := &deliveryPort{}
		service := NewService(namedAttributionRepository{name: name}, sender).WithCredentials(nil, strings.Repeat("ab09", 20))
		if _, err := service.Send(context.Background(), accessgrants.Subject{}, Report{Description: "Could not connect"}); err == nil {
			t.Fatal("credential-bearing attribution accepted")
		}
		if sender.report.Description != "" {
			t.Fatal("credential-bearing name reached delivery port")
		}
	}
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
		sender.report = Delivery{}
		if _, err := service.Send(context.Background(), accessgrants.Subject{}, Report{Description: strings.Join([]string{"eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJmaXh0dXJlIn0", "signaturefixturebyteshere"}, ".")}); !errors.Is(err, ErrCredentials) {
			t.Error("ordinary name hid a later JWT")
		}
		if sender.report.Description != "" {
			t.Error("JWT reached delivery after ordinary name")
		}
	}
}

type liveReportCredentials struct {
	values []string
	err    error
}

func (s liveReportCredentials) Credentials(context.Context, accessgrants.Subject) ([]string, error) {
	return s.values, s.err
}

func TestReportRejectsExactLiveCredentials(t *testing.T) {
	// Deliberately lacks a structured token prefix or generic code-sized run:
	// exact matching must not depend on a particular signing format or length.
	known := "opaquecallcredential"
	for _, source := range []string{"media", "invite", "server"} {
		for chunk := 2; chunk <= len(known); chunk++ {
			t.Run(fmt.Sprintf("%s_%d", source, chunk), func(t *testing.T) {
				ctx := context.Background()
				sender := &deliveryPort{}
				service := NewService(attributionRepository{}, sender)
				if source == "media" {
					ctx = WithRequestCredentials(ctx, known)
				} else if source == "invite" {
					service = service.WithCredentials(liveReportCredentials{values: []string{known}})
				} else {
					service = service.WithCredentials(nil, known)
				}
				var split strings.Builder
				for i, c := range known {
					if i > 0 && i%chunk == 0 {
						split.WriteString("&#9;\u200b:;")
					}
					split.WriteRune(c + 0xfee0)
				}
				if _, err := service.Send(ctx, accessgrants.Subject{}, Report{Description: "Call failed: " + split.String()}); !errors.Is(err, ErrCredentials) {
					t.Fatal("live credential was not rejected")
				}
				if sender.report.Description != "" {
					t.Fatal("live credential reached delivery port")
				}
			})
		}
	}
	sender := &deliveryPort{}
	service := NewService(attributionRepository{}, sender).WithCredentials(liveReportCredentials{err: errors.New("private source error")})
	if _, err := service.Send(context.Background(), accessgrants.Subject{}, Report{Description: "Could not connect"}); !errors.Is(err, ErrDelivery) || strings.Contains(err.Error(), "private source error") {
		t.Fatal("credential source failure was not bounded")
	}
	if sender.report.Description != "" {
		t.Fatal("delivery bypassed unavailable credential source")
	}
}
