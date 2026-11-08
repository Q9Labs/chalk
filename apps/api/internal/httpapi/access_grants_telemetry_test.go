package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func TestAccessGrantIssuanceChalkSFUDeclared(t *testing.T) {
	for _, path := range []string{"admission", "access grant"} {
		for _, tc := range []struct {
			name     string
			header   string
			declared bool
		}{
			{"declared", "cloudflare_sfu, chalk_sfu", true},
			{"absent", "", false},
			{"other", "cloudflare_sfu,future_sfu", false},
		} {
			for _, failure := range []string{"", "media"} {
				t.Run(path+"/"+tc.name+"/"+failure, func(t *testing.T) {
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
					fixture := &issuanceTelemetryFixture{}
					fixture.failure = failure
					subject := participantMediaSubject(t)
					fixture.admission.Participant = episodes.Participant{
						TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID,
						ID: subject.ParticipantID, Generation: subject.ParticipantGeneration,
					}
					issuer := observability.InstrumentAccessGrantIssuer(fixture, observability.NewLaunchTelemetry(slog.New(slog.NewTextHandler(io.Discard, nil))))
					body := `{"name":"Participant"}`
					if path == "access grant" {
						body = `{"participant_generation":7,"replace_media_connection":true}`
					}
					request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
					if tc.header != "" {
						request.Header.Set(mediaProvidersHeader, tc.header)
					}
					route := chi.NewRouteContext()
					route.URLParams.Add("tenant_id", subject.TenantID.String())
					route.URLParams.Add("space_id", subject.SpaceID.String())
					route.URLParams.Add("episode_id", subject.EpisodeID.String())
					route.URLParams.Add("participant_id", subject.ParticipantID.String())
					request = request.WithContext(context.WithValue(ctx, chi.RouteCtxKey, route))
					ctx = authentication.ContextWithPrincipal(ctx, authentication.Principal{Kind: authentication.PrincipalUser, UserID: subject.ParticipantID})
					var issuanceErr error
					if path == "admission" {
						endpoint := admitParticipantEndpoint(fixture, nil, fixture, issuer, fixture, fixture, fixture, fixture, fixture)
						decoded, err := endpoint.decode(request)
						if err != nil {
							t.Fatal(err)
						}
						_, issuanceErr = endpoint.handle(ctx, decoded)
					} else {
						endpoint := issueAccessGrantEndpoint(fixture, issuer, fixture, fixture, fixture, fixture, fixture, fixture, fixture)
						decoded, err := endpoint.decode(request)
						if err != nil {
							t.Fatal(err)
						}
						_, issuanceErr = endpoint.handle(ctx, decoded)
					}
					outcome, reason := "issued", "none"
					if failure != "" {
						outcome, reason = "failed", "signing_failed"
						if !errors.Is(issuanceErr, errReplacementCredential) {
							t.Fatalf("issuance error = %v", issuanceErr)
						}
					} else if issuanceErr != nil {
						t.Fatal(issuanceErr)
					}
					var metrics metricdata.ResourceMetrics
					if err := reader.Collect(ctx, &metrics); err != nil {
						t.Fatal(err)
					}
					counterSeen, durationSeen := false, false
					for _, scope := range metrics.ScopeMetrics {
						for _, metric := range scope.Metrics {
							switch metric.Name {
							case "chalk.api.access_grant.issuance":
								points := metric.Data.(metricdata.Sum[int64]).DataPoints
								if len(points) != 1 || points[0].Value != 1 {
									t.Fatalf("issuance points = %+v", points)
								}
								want := attribute.NewSet(attribute.String("outcome", outcome), attribute.String("reason", reason), attribute.Bool("chalk_sfu_declared", tc.declared))
								if !points[0].Attributes.Equals(&want) {
									t.Fatalf("issuance tags = %v, want %v", points[0].Attributes, want)
								}
								counterSeen = true
							case "chalk.api.access_grant.issuance.duration_seconds":
								points := metric.Data.(metricdata.Histogram[float64]).DataPoints
								want := attribute.NewSet(attribute.String("outcome", outcome), attribute.String("reason", reason))
								if len(points) != 1 || points[0].Count != 1 || !points[0].Attributes.Equals(&want) {
									t.Fatalf("duration points = %+v, want unchanged tags %v", points, want)
								}
								durationSeen = true
							}
						}
					}
					if !counterSeen || !durationSeen {
						t.Fatal("missing issuance counter or duration metric")
					}
				})
			}
		}
	}
}

type issuanceTelemetryFixture struct {
	replacementGrantFixture
	EpisodeLifecycleService
	admission episodes.Admission
}

func (f *issuanceTelemetryFixture) AdmitParticipant(context.Context, episodes.AdmitParticipantInput) (episodes.Admission, error) {
	return f.admission, nil
}

func (*issuanceTelemetryFixture) IssueForParticipant(context.Context, synctokens.SubjectKey) (synctokens.Token, error) {
	return synctokens.Token{Value: "sync-fixture"}, nil
}
