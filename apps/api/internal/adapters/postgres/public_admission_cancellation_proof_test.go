package postgres

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func proveAdmissionCancellation(t *testing.T, ctx context.Context, pool *pgxpool.Pool, repository PublicInviteRepository, proof *admissionOutcomeProof, tenantID, spaceID utilities.ID, newKnock func(string) (publicinvites.Arrival, publicinvites.AdmissionRequest)) {
	journeyID := accountTenantIntegrationID(t)
	ctx = proof.start(ctx, journeyID)
	ctx, span := otel.Tracer("proof").Start(ctx, "guest.cancel")
	arrival, _ := newKnock("Cancelled guest")
	runtime, err := publicinvites.NewRuntime(publicinvites.NewService(repository), admissionProofSpace{value: publicinvites.PublicSpace{TenantID: tenantID, SpaceID: spaceID, AdmissionMode: publicinvites.AdmissionKnock}}, repository, &terminalAdmissionAccess{}, admissionProofAccounts{}, admissionProofLinks{})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := runtime.Leave(ctx, publicinvites.PublicInviteLeaveInput{ArrivalHandle: arrival.ArrivalHandle.String(), GuestCredential: base64.RawURLEncoding.EncodeToString([]byte("isolated-test-guest-credential"))}); err != nil {
			t.Fatal(err)
		}
	}
	span.End()
	var count int
	if err := pool.QueryRow(ctx, `select count(*) from observability_journey_events e join space_public_arrivals a on a.arrival_handle=(e.attributes->>'arrival_handle')::uuid where e.journey_id=$1 and e.name='participant.admission_cancelled' and e.phase='terminal' and e.state='cancelled' and e.trace_id=$2 and e.span_id=$3 and a.arrival_handle=$4 and a.state='unavailable' and a.terminal_reason='cancelled'`, uuid(journeyID), span.SpanContext().TraceID().String(), span.SpanContext().SpanID().String(), uuid(arrival.ArrivalHandle)).Scan(&count); err != nil || count != 1 {
		t.Fatalf("cancellation must persist one correlated terminal outcome with arrival: count=%d err=%v", count, err)
	}
	for _, field := range []string{`"event":"public_invite.admission"`, `"reason":"cancelled"`, `"state":"unavailable"`, arrival.ArrivalHandle.String()} {
		if !strings.Contains(proof.logs.String(), field) {
			t.Fatalf("cancellation log missing %s: %s", field, proof.logs.String())
		}
	}
	var data metricdata.ResourceMetrics
	if err := proof.reader.Collect(ctx, &data); err != nil {
		t.Fatal(err)
	}
	foundMetric, foundSpan := false, false
	for _, scope := range data.ScopeMetrics {
		for _, measurement := range scope.Metrics {
			if measurement.Name != "chalk.public_invite.admission.outcomes" {
				continue
			}
			for _, point := range measurement.Data.(metricdata.Sum[int64]).DataPoints {
				reason, _ := point.Attributes.Value(attribute.Key("reason"))
				state, _ := point.Attributes.Value(attribute.Key("state"))
				if reason.AsString() == "cancelled" && state.AsString() == "unavailable" && point.Attributes.Len() == 2 && point.Value == 1 {
					foundMetric = true
				}
			}
		}
	}
	for _, recorded := range proof.exporter.GetSpans() {
		for _, field := range recorded.Attributes {
			if field.Key == "chalk.public_invite.admission.reason" && field.Value.AsString() == "cancelled" && recorded.SpanContext.TraceID() == span.SpanContext().TraceID() && recorded.SpanContext.SpanID() == span.SpanContext().SpanID() {
				foundSpan = true
			}
		}
	}
	if !foundMetric || !foundSpan {
		t.Fatalf("missing bounded cancellation signal: metric=%v span=%v", foundMetric, foundSpan)
	}
}
