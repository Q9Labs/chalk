package sfu

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

func (a Adapter) VerifyConnectionMetadata(ctx context.Context, connectionRef string) (metadata ConnectionMetadata, err error) {
	connectionRef = strings.TrimSpace(connectionRef)
	if connectionRef == "" {
		return ConnectionMetadata{}, mediaplane.ErrInvalidConnectionRef
	}
	ctx, span := sfuTracer.Start(ctx, "mediaplane.cloudflare.sfu.verify_connection", trace.WithSpanKind(trace.SpanKindClient))
	defer func() {
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				span.RecordError(sfuSpanError(err))
				span.SetStatus(codes.Error, "Cloudflare SFU request failed")
			}
			recordProviderFailure(ctx, span, err)
		}
		span.End()
	}()
	span.SetAttributes(attribute.String("http.request.method", http.MethodGet), attribute.String("server.address", "rtc.live.cloudflare.com"))

	if a.client == nil {
		return ConnectionMetadata{}, newProviderFailure("verify_connection", failureStageTransport, 0, "plane_unavailable")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/apps/%s/sessions/%s", a.endpoint, url.PathEscape(a.appID), url.PathEscape(connectionRef)), nil)
	if err != nil {
		return ConnectionMetadata{}, newProviderFailure("verify_connection", failureStageContract, 0, "invalid_request")
	}
	request.Header.Set("Authorization", "Bearer "+a.appSecret)
	request.Header.Set("Accept", "application/json")

	response, err := a.client.Do(request)
	if err != nil {
		return ConnectionMetadata{}, newTransportFailure(ctx, "verify_connection", 0, err)
	}
	defer response.Body.Close()
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))

	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return ConnectionMetadata{}, newTransportFailure(ctx, "verify_connection", response.StatusCode, err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		failure := sfuStatusError("verify_connection", response.StatusCode, payload)
		return ConnectionMetadata{}, enrichProviderFailure(failure, nil, len(payload))
	}

	return ConnectionMetadata{
		Provider: mediaplane.ProviderCloudflareSFU,
		Ref:      connectionRef,
		Metadata: a.providerMetadata(),
	}, nil
}

func (a Adapter) providerMetadata() map[string]string {
	return map[string]string{
		"api_base":    fmt.Sprintf("%s/apps/%s", a.endpoint, a.appID),
		"app_id":      a.appID,
		"stun_server": stunServer,
		"sync_owner":  syncOwner,
	}
}

func (a Adapter) joinForConnection(episodeRef string, participantRef string, connectionID string, iceServers []mediaplane.ICEServer) mediaplane.Join {
	return mediaplane.Join{
		Provider:       mediaplane.ProviderCloudflareSFU,
		ParticipantRef: participantRef,
		ClientPayload: map[string]any{
			"connectionId": connectionID,
			"provider":     string(mediaplane.ProviderCloudflareSFU),
			"episodeRef":   episodeRef,
			"stunServer":   stunServer,
			"iceServers":   iceServers,
			"syncOwner":    syncOwner,
		},
		Metadata: a.providerMetadata(),
	}
}
