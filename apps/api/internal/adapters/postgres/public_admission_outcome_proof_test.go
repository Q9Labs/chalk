package postgres

import (
	"bytes"
	"context"
	"encoding/base64"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

type admissionOutcomeProof struct {
	logs      bytes.Buffer
	reader    *metric.ManualReader
	exporter  *tracetest.InMemoryExporter
	source    trace.SpanContext
	journeyID utilities.ID
}

func captureAdmissionOutcomeProof(t *testing.T) *admissionOutcomeProof {
	t.Helper()
	proof := &admissionOutcomeProof{reader: metric.NewManualReader(), exporter: tracetest.NewInMemoryExporter()}
	meters := metric.NewMeterProvider(metric.WithReader(proof.reader))
	traces := sdktrace.NewTracerProvider(sdktrace.WithSyncer(proof.exporter))
	previousMeters, previousTraces, previousLogger := otel.GetMeterProvider(), otel.GetTracerProvider(), slog.Default()
	otel.SetMeterProvider(meters)
	otel.SetTracerProvider(traces)
	slog.SetDefault(slog.New(slog.NewJSONHandler(&proof.logs, nil)))
	t.Cleanup(func() {
		slog.SetDefault(previousLogger)
		otel.SetMeterProvider(previousMeters)
		otel.SetTracerProvider(previousTraces)
		_ = meters.Shutdown(context.Background())
		_ = traces.Shutdown(context.Background())
	})
	return proof
}

func (p *admissionOutcomeProof) start(ctx context.Context, journeyID utilities.ID) context.Context {
	ctx, span := otel.Tracer("proof").Start(observability.ContextWithJourneyID(ctx, journeyID), "guest.knock")
	p.source, p.journeyID = span.SpanContext(), journeyID
	span.End()
	return ctx
}

func (p *admissionOutcomeProof) assertNotCollected(t *testing.T, ctx context.Context, tenantID, spaceID, handle utilities.ID) {
	t.Helper()
	for _, fragment := range []string{`"event":"public_invite.admission"`, `"reason":"admission_not_collected"`, `"state":"unavailable"`, tenantID.String(), spaceID.String(), handle.String()} {
		if !strings.Contains(p.logs.String(), fragment) {
			t.Fatalf("missing uncollected admission log field %s: %s", fragment, p.logs.String())
		}
	}
	var data metricdata.ResourceMetrics
	if err := p.reader.Collect(ctx, &data); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, scope := range data.ScopeMetrics {
		for _, measurement := range scope.Metrics {
			if measurement.Name != "chalk.public_invite.admission.outcomes" {
				continue
			}
			for _, point := range measurement.Data.(metricdata.Sum[int64]).DataPoints {
				reason, _ := point.Attributes.Value(attribute.Key("reason"))
				if reason.AsString() != "admission_not_collected" {
					continue
				}
				state, _ := point.Attributes.Value(attribute.Key("state"))
				if point.Value != 1 || point.Attributes.Len() != 2 || state.AsString() != "unavailable" {
					t.Fatalf("unbounded or duplicated outcome: %+v", point)
				}
				found = true
			}
		}
	}
	if !found {
		t.Fatal("missing admission_not_collected metric")
	}
	for _, span := range p.exporter.GetSpans() {
		for _, field := range span.Attributes {
			if field.Key == "chalk.public_invite.admission.reason" && field.Value.AsString() == "admission_not_collected" {
				if len(span.Links) != 1 || (span.Links[0].SpanContext.TraceID() != p.source.TraceID() || span.Links[0].SpanContext.SpanID() != p.source.SpanID()) {
					t.Fatalf("cleanup lost its request trace link: %+v", span.Links)
				}
				foundJourney := false
				for _, attribute := range span.Attributes {
					if attribute.Key == "journey.id" && attribute.Value.AsString() == p.journeyID.String() {
						foundJourney = true
					}
				}
				if !foundJourney {
					t.Fatal("cleanup lost its original journey")
				}
				return
			}
		}
	}
	t.Fatal("missing admission_not_collected span")
}

type admissionProofSpace struct {
	publicinvites.Space
	value publicinvites.PublicSpace
}

func (s admissionProofSpace) GetPublicSpace(context.Context, utilities.ID, utilities.ID) (publicinvites.PublicSpace, error) {
	return s.value, nil
}

type admissionProofAccounts struct{ publicinvites.Accounts }
type admissionProofLinks struct{ publicinvites.Links }
type terminalAdmissionAccess struct {
	publicinvites.Access
	grant     func(context.Context, publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error)
	discarded int
}

func (a *terminalAdmissionAccess) GrantPublicAccess(ctx context.Context, input publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error) {
	return a.grant(ctx, input)
}
func (a *terminalAdmissionAccess) DiscardPublicAccess(context.Context, publicinvites.PublicAccessGrant) error {
	a.discarded++
	return nil
}

func proveTerminalAdmissionCollection(t *testing.T, ctx context.Context, pool *pgxpool.Pool, service publicinvites.Service, repository PublicInviteRepository, lifecycle EpisodeLifecycleRepository, tenantID, spaceID, episodeID, accountID utilities.ID, newKnock func(string) (publicinvites.Arrival, publicinvites.AdmissionRequest)) {
	for _, terminal := range []string{"active", "episode_ended", "participant_left", "participant_leaving"} {
		t.Run(terminal, func(t *testing.T) {
			arrival, request := newKnock(terminal)
			if _, _, err := service.DecideAdmissionRequest(ctx, publicinvites.DecideAdmissionRequestInput{TenantID: tenantID, SpaceID: spaceID, RequestHandle: request.RequestHandle, ActorID: accountID, Decision: publicinvites.DecisionApprove}); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if _, err := pool.Exec(ctx, `update episodes set status='active',ended_at=null where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(episodeID)); err != nil {
					t.Error(err)
				}
			})
			exec := func(query string, args ...any) {
				t.Helper()
				if _, err := pool.Exec(ctx, query, args...); err != nil {
					t.Fatal(err)
				}
			}
			exec(`update participants set status='active', joined_at=now() where tenant_id=$1 and id=(select participant_id from sync_admission_requests where tenant_id=$1 and admission_request_id=$2)`, uuid(tenantID), uuid(request.RequestHandle))
			exec(`update sync_admission_requests set status='admitted', completed_at=now() where tenant_id=$1 and admission_request_id=$2`, uuid(tenantID), uuid(request.RequestHandle))
			access := &terminalAdmissionAccess{}
			access.grant = func(ctx context.Context, input publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error) {
				if input.Admission == nil {
					t.Fatal("canonical admission binding missing")
				}
				binding := input.Admission
				// This is the production lookup. End the seat after it releases its locks,
				// but before Runtime saves this provider grant in the arrival transaction.
				if _, err := lifecycle.FindPublic(ctx, episodes.PublicAccessInput{TenantID: tenantID, SpaceID: spaceID, EpisodeID: binding.EpisodeID, ParticipantID: binding.ParticipantID, ParticipantGeneration: binding.ParticipantGeneration, IdentityMode: "guest"}); err != nil {
					t.Fatal(err)
				}
				if terminal == "episode_ended" {
					exec(`update episodes set status='ended',ended_at=now() where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(episodeID))

				} else if terminal != "active" {
					status := "left"
					if terminal == "participant_leaving" {
						status = "leaving"
					}
					exec(`update participants set status=$3 where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(binding.ParticipantID), status)
				}
				return publicinvites.PublicAccessGrant{TenantID: tenantID, SpaceID: spaceID, EpisodeID: binding.EpisodeID, ParticipantID: binding.ParticipantID, ParticipantGeneration: binding.ParticipantGeneration, Provider: publicinvites.PublicProviderCloudflareSFU, ProviderSubject: "racing-connection", ClientPayload: publicinvites.PublicAccessClientPayload{ConnectionID: "racing-connection", StunServer: "stun:fixture"}, ExpiresAt: time.Now().Add(time.Hour)}, nil
			}
			runtime, err := publicinvites.NewRuntime(service, admissionProofSpace{value: publicinvites.PublicSpace{TenantID: tenantID, SpaceID: spaceID, AdmissionMode: publicinvites.AdmissionKnock}}, repository, access, admissionProofAccounts{}, admissionProofLinks{})
			if err != nil {
				t.Fatal(err)
			}
			result, err := runtime.ArrivalStatus(ctx, publicinvites.PublicInviteArrivalStatusInput{ArrivalHandle: arrival.ArrivalHandle.String(), GuestCredential: base64.RawURLEncoding.EncodeToString([]byte("isolated-test-guest-credential"))}, func() error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			if terminal == "active" {
				if result.State != publicinvites.ArrivalAdmitted || result.Access == nil || access.discarded != 0 {
					t.Fatalf("live seat failed collection: state=%s access=%v discarded=%d", result.State, result.Access != nil, access.discarded)
				}
				return
			}
			if result.State == publicinvites.ArrivalAdmitted || result.Access != nil || access.discarded != 1 {
				t.Fatalf("terminal seat returned access: state=%s access=%v discarded=%d", result.State, result.Access != nil, access.discarded)
			}
			stored, err := repository.GetArrival(ctx, arrival.ArrivalHandle)
			if err != nil {
				t.Fatal(err)
			}
			if stored.State == publicinvites.ArrivalAdmitted || stored.ProviderSubject != "" || !stored.EpisodeID.IsZero() {
				t.Fatalf("terminal grant persisted: %+v", stored)
			}
		})
	}
}
