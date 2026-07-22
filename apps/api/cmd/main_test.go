package main

import (
	"context"
	"net/http"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/integrations"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

type testWorkloadAuthorizer struct{}

func (testWorkloadAuthorizer) AuthorizeWorkload(context.Context, *http.Request, string) error {
	return nil
}

func TestApplyCapabilityProfileDisablesOptionalRouteServices(t *testing.T) {
	options := populatedCapabilityOptions()

	applyCapabilityProfile(&options, config.CapabilityConfig{})

	if options.Capabilities.Integrations || options.Capabilities.Transcription {
		t.Fatalf("capabilities = %#v, want disabled", options.Capabilities)
	}
	if options.Integrations != nil || options.Transcripts != nil || options.TranscriptArtifacts != nil || options.TranscriptWorker != nil || options.WorkloadAuthorizer != nil || options.ChunkAuthority != nil || options.ManifestAuthority != nil || options.ResultAuthority != nil || options.CleanupWorker != nil || options.CleanupDeleteAuthority != nil || options.FinalizerWorker != nil || options.FinalizerAuthority != nil {
		t.Fatal("disabled capability retained a route service")
	}
}

func TestApplyCapabilityProfilePreservesEnabledRouteServices(t *testing.T) {
	options := populatedCapabilityOptions()

	applyCapabilityProfile(&options, config.CapabilityConfig{Integrations: true, Transcription: true})

	if !options.Capabilities.Integrations || !options.Capabilities.Transcription {
		t.Fatalf("capabilities = %#v, want enabled", options.Capabilities)
	}
	if options.Integrations == nil || options.Transcripts == nil || options.TranscriptArtifacts == nil || options.TranscriptWorker == nil || options.WorkloadAuthorizer == nil || options.ChunkAuthority == nil || options.ManifestAuthority == nil || options.ResultAuthority == nil || options.CleanupWorker == nil || options.CleanupDeleteAuthority == nil || options.FinalizerWorker == nil || options.FinalizerAuthority == nil {
		t.Fatal("enabled capability lost a route service")
	}
}

func populatedCapabilityOptions() httpapi.Options {
	integrationService := integrations.NewService(nil, nil, integrations.Catalog{})
	transcriptService := transcripts.NewService(nil)
	authority := &transcriptionObjectAuthority{}
	return httpapi.Options{
		Integrations:           integrationService,
		Transcripts:            transcriptService,
		TranscriptArtifacts:    transcriptService,
		TranscriptWorker:       transcriptService,
		WorkloadAuthorizer:     testWorkloadAuthorizer{},
		ChunkAuthority:         authority,
		ManifestAuthority:      authority,
		ResultAuthority:        authority,
		CleanupWorker:          transcriptService,
		CleanupDeleteAuthority: authority,
		FinalizerWorker:        transcriptService,
		FinalizerAuthority:     authority,
	}
}
