package publicinviteapp

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
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
