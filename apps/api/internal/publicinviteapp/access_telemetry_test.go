package publicinviteapp

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func TestPublicAccessIssuanceChalkSFUDeclared(t *testing.T) {
	for _, refresh := range []bool{false, true} {
		for _, tc := range []struct {
			name     string
			provider mediaplane.Provider
			header   string
			declared bool
		}{
			{"Cloudflare declared", mediaplane.ProviderCloudflareSFU, "cloudflare_sfu,chalk_sfu", true},
			{"Cloudflare absent", mediaplane.ProviderCloudflareSFU, "", false},
			{"Cloudflare other", mediaplane.ProviderCloudflareSFU, "cloudflare_sfu,future_sfu", false},
			{"Chalk declared", mediaplane.ProviderChalkSFU, "chalk_sfu", true},
		} {
			name := "admission/" + tc.name
			if refresh {
				name = "refresh/" + tc.name
			}
			t.Run(name, func(t *testing.T) {
				ctx := context.Background()
				reader := sdkmetric.NewManualReader()
				provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
				previous := otel.GetMeterProvider()
				otel.SetMeterProvider(provider)
				t.Cleanup(func() {
					otel.SetMeterProvider(previous)
					if err := provider.Shutdown(ctx); err != nil {
						t.Error(err)
					}
				})
				fixture, access := newArrivalStatusFixture(t, tc.provider)
				fixture.media = mediaplane.NewServiceForProvider(tc.provider, publicIssuancePlane{fixture})
				access.mediaTokens = observability.InstrumentAccessGrantIssuer(fixture, observability.NewLaunchTelemetry(slog.New(slog.NewTextHandler(io.Discard, nil))))
				grant, err := access.issue(ctx, fixture.arrival, fixture.ready(), mediaplane.ParseClientProviders(tc.header), refresh, false)
				if err != nil || grant.MediaToken != "media-proof" {
					t.Fatalf("public issuance = %+v, %v", grant, err)
				}
				var metrics metricdata.ResourceMetrics
				if err := reader.Collect(ctx, &metrics); err != nil {
					t.Fatal(err)
				}
				for _, scope := range metrics.ScopeMetrics {
					for _, metric := range scope.Metrics {
						if metric.Name != "chalk.api.access_grant.issuance" {
							continue
						}
						points := metric.Data.(metricdata.Sum[int64]).DataPoints
						want := attribute.NewSet(attribute.String("outcome", "issued"), attribute.String("reason", "none"), attribute.Bool("chalk_sfu_declared", tc.declared))
						if len(points) != 1 || points[0].Value != 1 || !points[0].Attributes.Equals(&want) {
							t.Fatalf("public issuance points = %+v, want tags %v", points, want)
						}
						return
					}
				}
				t.Fatal("missing public issuance counter")
			})
		}
	}
}

type publicIssuancePlane struct{ *arrivalStatusFixture }

func (f publicIssuancePlane) CreateJoin(ctx context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	return f.ResumeJoin(ctx, mediaplane.ResumeJoinInput{Provider: input.Provider, ConnectionRef: f.arrival.ProviderSubject})
}

func TestHostApprovedLegacyGuestOmitsChalkSFUDeclaration(t *testing.T) {
	ctx := context.Background()
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previous := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		otel.SetMeterProvider(previous)
		if err := provider.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	base, access := newArrivalStatusFixture(t, mediaplane.ProviderCloudflareSFU)
	base.arrival.State = publicinvites.ArrivalPending
	fixture := &legacyApprovalTelemetryFixture{base}
	base.media = mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, publicIssuancePlane{base})
	access.episodes = fixture
	access.mediaTokens = observability.InstrumentAccessGrantIssuer(fixture, observability.NewLaunchTelemetry(slog.New(slog.NewTextHandler(io.Discard, nil))))
	runtime, err := publicinvites.NewRuntime(publicinvites.NewService(fixture, publicinvites.Signer{}), fixture, fixture, access, fixture, fixture)
	if err != nil {
		t.Fatal(err)
	}
	request, err := runtime.ApproveAdmissionRequest(ctx, publicinvites.DecidePublicAdmissionRequestInput{
		TenantID: base.arrival.TenantID, SpaceID: base.arrival.SpaceID,
		RequestHandle: base.arrival.ArrivalHandle.String(), ActorID: base.arrival.ParticipantID,
	})
	if err != nil || request.State != publicinvites.AdmissionRequestApproved || base.arrival.State != publicinvites.ArrivalAdmitted {
		t.Fatalf("legacy approval = %+v, %v; arrival state = %s", request, err, base.arrival.State)
	}
	var metrics metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &metrics); err != nil {
		t.Fatal(err)
	}
	for _, scope := range metrics.ScopeMetrics {
		for _, metric := range scope.Metrics {
			if metric.Name != "chalk.api.access_grant.issuance" {
				continue
			}
			points := metric.Data.(metricdata.Sum[int64]).DataPoints
			want := attribute.NewSet(attribute.String("outcome", "issued"), attribute.String("reason", "none"))
			if len(points) != 1 || points[0].Value != 1 || !points[0].Attributes.Equals(&want) {
				t.Fatalf("host approval issuance points = %+v, want only %v", points, want)
			}
			return
		}
	}
	t.Fatal("missing host approval issuance counter")
}

type legacyApprovalTelemetryFixture struct{ *arrivalStatusFixture }

func (f *legacyApprovalTelemetryFixture) DecideAdmissionRequest(context.Context, publicinvites.DecideAdmissionRequestInput) (publicinvites.AdmissionRequest, publicinvites.Arrival, error) {
	return publicinvites.AdmissionRequest{State: publicinvites.AdmissionRequestApproved}, f.arrival, nil
}

func (f *legacyApprovalTelemetryFixture) GetPublicSpace(context.Context, utilities.ID, utilities.ID) (publicinvites.PublicSpace, error) {
	return publicinvites.PublicSpace{TenantID: f.arrival.TenantID, SpaceID: f.arrival.SpaceID, AdmissionMode: publicinvites.AdmissionKnock}, nil
}

func (f *legacyApprovalTelemetryFixture) JoinPublic(context.Context, episodes.PublicJoinInput) (episodes.PublicJoinResult, error) {
	return f.ready(), nil
}

func (f *legacyApprovalTelemetryFixture) UpdateArrivalState(_ context.Context, input publicinvites.UpdateArrivalStateInput) (publicinvites.Arrival, error) {
	f.arrival.State = input.State
	return f.arrival, nil
}
