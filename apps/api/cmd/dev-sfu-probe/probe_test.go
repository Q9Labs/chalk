package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	sfuadapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

type clientStub struct {
	create func(context.Context, mediaplane.CreateJoinInput) (mediaplane.Join, error)
	verify func(context.Context, string) (sfuadapter.SessionMetadata, error)
}

func (s clientStub) CreateJoin(ctx context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	return s.create(ctx, input)
}

func (s clientStub) VerifySessionMetadata(ctx context.Context, connectionID string) (sfuadapter.SessionMetadata, error) {
	return s.verify(ctx, connectionID)
}

func TestProbeCreatesAndVerifiesNoTrackConnectionWithoutReturningIdentifiers(t *testing.T) {
	var createInput mediaplane.CreateJoinInput
	var verifiedConnectionID string
	probe := NewProbe(clientStub{
		create: func(_ context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
			createInput = input
			return mediaplane.Join{ClientPayload: map[string]any{"connectionId": "connection-secret"}}, nil
		},
		verify: func(_ context.Context, connectionID string) (sfuadapter.SessionMetadata, error) {
			verifiedConnectionID = connectionID
			return sfuadapter.SessionMetadata{Provider: mediaplane.ProviderCloudflareSFU, Ref: connectionID}, nil
		},
	})

	result, err := probe.Run(context.Background())
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if createInput.Provider != mediaplane.ProviderCloudflareSFU || createInput.Session.Ref == "" || createInput.ParticipantPreset == "" {
		t.Fatalf("create input = %+v", createInput)
	}
	if verifiedConnectionID != "connection-secret" {
		t.Fatalf("verified connection id = %q", verifiedConnectionID)
	}
	if result.Status != "ok" || !result.Verified {
		t.Fatalf("result = %+v", result)
	}

	encoded, err := jsonResult(result)
	if err != nil {
		t.Fatalf("encode result: %v", err)
	}
	if strings.Contains(encoded, "connection-secret") || strings.Contains(encoded, "cloudflare") || strings.Contains(encoded, "provider") {
		t.Fatalf("result leaked provider details: %s", encoded)
	}
}

func TestProbeClassifiesAuthenticationFailureWithoutProviderPayload(t *testing.T) {
	const secret = "provider-response-secret"
	probe := NewProbe(clientStub{
		create: func(context.Context, mediaplane.CreateJoinInput) (mediaplane.Join, error) {
			return mediaplane.Join{}, fmt.Errorf("provider body %s: %w", secret, mediaplane.ErrProviderUnauthorized)
		},
		verify: func(context.Context, string) (sfuadapter.SessionMetadata, error) {
			t.Fatal("verify should not run after create failure")
			return sfuadapter.SessionMetadata{}, nil
		},
	})

	_, err := probe.Run(context.Background())
	if err == nil {
		t.Fatal("probe succeeded")
	}
	var probeErr ProbeError
	if !errors.As(err, &probeErr) || probeErr.Class != FailureAuthentication || probeErr.Stage != "create_connection" {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error leaked provider payload: %v", err)
	}
}

func TestProbeClassifiesTimeoutWithoutProviderPayload(t *testing.T) {
	const secret = "timeout-provider-payload"
	probe := NewProbe(clientStub{
		create: func(ctx context.Context, _ mediaplane.CreateJoinInput) (mediaplane.Join, error) {
			<-ctx.Done()
			return mediaplane.Join{}, fmt.Errorf("%s: %w", secret, ctx.Err())
		},
		verify: func(context.Context, string) (sfuadapter.SessionMetadata, error) {
			t.Fatal("verify should not run after timeout")
			return sfuadapter.SessionMetadata{}, nil
		},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 1)
	defer cancel()
	_, err := probe.Run(ctx)
	if err == nil {
		t.Fatal("probe succeeded")
	}
	var probeErr ProbeError
	if !errors.As(err, &probeErr) || probeErr.Class != FailureTimeout {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error leaked provider payload: %v", err)
	}
}

func TestProbeClassifiesAdapterTimeoutWithoutProviderPayload(t *testing.T) {
	probe := NewProbe(clientStub{
		create: func(context.Context, mediaplane.CreateJoinInput) (mediaplane.Join, error) {
			return mediaplane.Join{}, fmt.Errorf("provider_code=timeout")
		},
		verify: func(context.Context, string) (sfuadapter.SessionMetadata, error) {
			t.Fatal("verify should not run after timeout")
			return sfuadapter.SessionMetadata{}, nil
		},
	})

	_, err := probe.Run(context.Background())
	if err == nil {
		t.Fatal("probe succeeded")
	}
	var probeErr ProbeError
	if !errors.As(err, &probeErr) || probeErr.Class != FailureTimeout {
		t.Fatalf("error = %v", err)
	}
}

func TestProbeRejectsEmptyConnectionIDWithoutReturningPayload(t *testing.T) {
	const payload = "raw-provider-payload"
	probe := NewProbe(clientStub{
		create: func(context.Context, mediaplane.CreateJoinInput) (mediaplane.Join, error) {
			return mediaplane.Join{ClientPayload: map[string]any{"connectionId": payload[:0]}}, nil
		},
		verify: func(context.Context, string) (sfuadapter.SessionMetadata, error) {
			t.Fatal("verify should not run with an empty connection id")
			return sfuadapter.SessionMetadata{}, nil
		},
	})

	_, err := probe.Run(context.Background())
	if err == nil {
		t.Fatal("probe succeeded")
	}
	var probeErr ProbeError
	if !errors.As(err, &probeErr) || probeErr.Class != FailureInvalidResponse || !errors.Is(err, ErrInvalidConnectionID) {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(err.Error(), payload) {
		t.Fatalf("error leaked provider payload: %v", err)
	}
}

func TestNewClientFromEnvRequiresBothCredentialsWithoutRedactionLeak(t *testing.T) {
	const secret = "provider-secret"
	client, err := NewClientFromEnv(func(name string) string {
		if name == config.CloudflareRealtimeAppSecret {
			return secret
		}
		return ""
	})
	if client != nil || err == nil {
		t.Fatalf("client/error = %v/%v", client, err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error leaked credential: %v", err)
	}
}

func jsonResult(result Result) (string, error) {
	var output strings.Builder
	if err := json.NewEncoder(&output).Encode(result); err != nil {
		return "", err
	}
	return output.String(), nil
}
