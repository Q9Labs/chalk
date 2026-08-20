package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/integrations"
	"github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/recorderhealth"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

type testWorkloadAuthorizer struct{}

type testRecordingPipelineMetrics struct{}

func (testRecordingPipelineMetrics) RecordAdmission(context.Context, string, string) {}
func (testRecordingPipelineMetrics) RecordTransition(context.Context, string)        {}

func (testWorkloadAuthorizer) AuthorizeWorkload(context.Context, *http.Request, string) error {
	return nil
}

func TestResolvePublicInviteConfigReusesLocalTenantAndDerivesStableKeyring(t *testing.T) {
	tenantID := mustCmdTestID(t, "11111111-1111-4111-8111-111111111111")
	fake := &localPublicInviteTenantFake{tenants: []tenants.Tenant{{ID: tenantID, Name: localPublicInviteTenantName}}}
	cfg := localPublicInviteTestConfig()

	first, err := resolvePublicInviteConfig(context.Background(), cfg, fake)
	if err != nil {
		t.Fatalf("resolve local public invite config: %v", err)
	}
	second, err := resolvePublicInviteConfig(context.Background(), cfg, fake)
	if err != nil {
		t.Fatalf("resolve local public invite config again: %v", err)
	}
	if fake.createCalls != 0 {
		t.Fatalf("create calls = %d, want 0 for existing neutral Tenant", fake.createCalls)
	}
	if fake.listCalls != 2 {
		t.Fatalf("list calls = %d, want 2", fake.listCalls)
	}
	if first.ManagedTenantID != tenantID.String() || first.WebOrigin != "http://127.0.0.1:3070" || first.DefaultMediaPlane != mediaplaneproviders.SpaceProviderCloudflareSFU {
		t.Fatalf("local public invite config = %#v", first)
	}
	if first.SchedulerInterval != time.Duration(config.DefaultPublicInviteSchedulerIntervalMS)*time.Millisecond || first.SchedulerBatch != config.DefaultPublicInviteSchedulerBatch {
		t.Fatalf("local scheduler = %s/%d", first.SchedulerInterval, first.SchedulerBatch)
	}
	if !bytes.Equal(first.PrivateKey, second.PrivateKey) || !bytes.Equal(first.VerificationKeys[localPublicInviteKeyID], second.VerificationKeys[localPublicInviteKeyID]) {
		t.Fatal("local public invite keyring is not deterministic")
	}
	if len(first.PrivateKey) != ed25519.PrivateKeySize || len(first.VerificationKeys[localPublicInviteKeyID]) != ed25519.PublicKeySize {
		t.Fatalf("local public invite key sizes = %d/%d", len(first.PrivateKey), len(first.VerificationKeys[localPublicInviteKeyID]))
	}
}

func TestResolvePublicInviteConfigCreatesNeutralLocalTenantWithoutLoggingKey(t *testing.T) {
	tenantID := mustCmdTestID(t, "22222222-2222-4222-8222-222222222222")
	fake := &localPublicInviteTenantFake{created: tenants.Tenant{ID: tenantID, Name: localPublicInviteTenantName}}
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previousLogger)

	resolved, err := resolvePublicInviteConfig(context.Background(), localPublicInviteTestConfig(), fake)
	if err != nil {
		t.Fatalf("resolve local public invite config: %v", err)
	}
	if fake.createCalls != 1 || fake.createInput.Name != localPublicInviteTenantName {
		t.Fatalf("created local Tenant = %d/%q", fake.createCalls, fake.createInput.Name)
	}
	if fake.createInput.DefaultMediaPlane == nil || *fake.createInput.DefaultMediaPlane != mediaplaneproviders.SpaceProviderCloudflareSFU {
		t.Fatalf("created Tenant media plane = %#v", fake.createInput.DefaultMediaPlane)
	}
	if !json.Valid(fake.createInput.MediaPlaneProviderConfig) || !strings.Contains(string(fake.createInput.MediaPlaneProviderConfig), `"mode":"chalk_managed"`) {
		t.Fatalf("created Tenant provider config = %s", fake.createInput.MediaPlaneProviderConfig)
	}
	if strings.Contains(logs.String(), string(resolved.PrivateKey)) {
		t.Fatal("local public invite key material was logged")
	}
}

func TestResolvePublicInviteConfigDoesNotFallbackOutsideLocal(t *testing.T) {
	fake := &localPublicInviteTenantFake{}
	cfg := localPublicInviteTestConfig()
	cfg.Observability.Environment = "production"

	_, err := resolvePublicInviteConfig(context.Background(), cfg, fake)
	if !errors.Is(err, errHostedPublicInviteConfigRequired) {
		t.Fatalf("hosted config error = %v, want %v", err, errHostedPublicInviteConfigRequired)
	}
	if fake.listCalls != 0 || fake.createCalls != 0 {
		t.Fatalf("hosted fallback touched Tenant service: list/create = %d/%d", fake.listCalls, fake.createCalls)
	}
}

func TestResolvePublicInviteConfigUsesLocalWebOriginDefault(t *testing.T) {
	tenantID := mustCmdTestID(t, "11111111-1111-4111-8111-111111111111")
	fake := &localPublicInviteTenantFake{tenants: []tenants.Tenant{{ID: tenantID, Name: localPublicInviteTenantName}}}
	cfg := localPublicInviteTestConfig()
	cfg.API.CORSAllowedOrigins = nil

	resolved, err := resolvePublicInviteConfig(context.Background(), cfg, fake)
	if err != nil {
		t.Fatalf("resolve local public invite config without CORS origins: %v", err)
	}
	if resolved.WebOrigin != localPublicInviteWebDefault {
		t.Fatalf("local web origin = %q, want %q", resolved.WebOrigin, localPublicInviteWebDefault)
	}
}

func localPublicInviteTestConfig() config.Config {
	return config.Config{
		API:           config.APIConfig{CORSAllowedOrigins: []string{"http://127.0.0.1:3070"}},
		Observability: config.ObservabilityConfig{Environment: config.DefaultEnvironment},
		PublicInvite:  config.PublicInviteConfig{},
	}
}

func mustCmdTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse test Tenant ID: %v", err)
	}
	return id
}

type localPublicInviteTenantFake struct {
	tenants     []tenants.Tenant
	created     tenants.Tenant
	createInput tenants.CreateTenantInput
	listCalls   int
	createCalls int
}

func (f *localPublicInviteTenantFake) ListTenants(context.Context, pagination.PageRequest) (tenants.TenantList, error) {
	f.listCalls++
	return tenants.TenantList{Tenants: f.tenants}, nil
}

func (f *localPublicInviteTenantFake) CreateTenant(_ context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
	f.createCalls++
	f.createInput = input
	return f.created, nil
}

func TestApplyCapabilityProfileDisablesOptionalRouteServices(t *testing.T) {
	options := populatedCapabilityOptions()

	applyCapabilityProfile(&options, config.CapabilityConfig{})

	if options.Capabilities.Integrations || options.Capabilities.Recording || options.Capabilities.Transcription || options.Capabilities.WhiteboardFiles {
		t.Fatalf("capabilities = %#v, want disabled", options.Capabilities)
	}
	if options.Integrations != nil || options.RecordingDownloads != nil || options.RecordingObjects != nil || options.Recordings != nil || options.RecordingPipeline != nil || options.RecorderHealth != nil || options.RecorderMetrics != nil || options.Transcripts != nil || options.TranscriptArtifacts != nil || options.TranscriptWorker != nil || options.WorkloadAuthorizer != nil || options.ChunkAuthority != nil || options.ManifestAuthority != nil || options.ResultAuthority != nil || options.CleanupWorker != nil || options.CleanupDeleteAuthority != nil || options.FinalizerWorker != nil || options.FinalizerAuthority != nil {
		t.Fatal("disabled capability retained a route service")
	}
	if options.WhiteboardFiles != nil || options.WhiteboardParticipants != nil {
		t.Fatal("disabled whiteboard capability retained a route service")
	}
	if options.ChatAttachments == nil || options.ChatParticipants == nil {
		t.Fatal("disabling whiteboard files also disabled shared-R2 chat attachments")
	}
}

func TestApplyCapabilityProfilePreservesEnabledRouteServices(t *testing.T) {
	options := populatedCapabilityOptions()

	applyCapabilityProfile(&options, config.CapabilityConfig{Integrations: true, Recording: true, Transcription: true, WhiteboardFiles: true})

	if !options.Capabilities.Integrations || !options.Capabilities.Recording || !options.Capabilities.Transcription || !options.Capabilities.WhiteboardFiles {
		t.Fatalf("capabilities = %#v, want enabled", options.Capabilities)
	}
	if options.Integrations == nil || options.RecordingDownloads == nil || options.RecordingObjects == nil || options.Recordings == nil || options.RecordingPipeline == nil || options.RecorderHealth == nil || options.RecorderMetrics == nil || options.Transcripts == nil || options.TranscriptArtifacts == nil || options.TranscriptWorker == nil || options.WorkloadAuthorizer == nil || options.ChunkAuthority == nil || options.ManifestAuthority == nil || options.ResultAuthority == nil || options.CleanupWorker == nil || options.CleanupDeleteAuthority == nil || options.FinalizerWorker == nil || options.FinalizerAuthority == nil {
		t.Fatal("enabled capability lost a route service")
	}
	if options.WhiteboardFiles == nil || options.WhiteboardParticipants == nil {
		t.Fatal("enabled whiteboard capability lost a route service")
	}
	if options.ChatAttachments == nil || options.ChatParticipants == nil {
		t.Fatal("enabled whiteboard capability lost shared-R2 chat attachments")
	}
}

func populatedCapabilityOptions() httpapi.Options {
	integrationService := integrations.NewService(nil, nil, integrations.Catalog{})
	transcriptService := transcripts.NewService(nil)
	authority := &transcriptionObjectAuthority{}
	chatService := chatattachments.NewService(nil, nil)
	chatVerifier := chatattachments.NewParticipantVerifier(nil)
	whiteboardService := whiteboardfiles.NewService(nil, nil)
	whiteboardVerifier := whiteboardfiles.NewParticipantVerifier(nil)
	recordingStorage := objectstorage.NewService(nil)
	return httpapi.Options{
		Integrations:           integrationService,
		RecordingDownloads:     recordingStorage,
		RecordingObjects:       recordingStorage,
		Recordings:             recordings.NewService(nil),
		RecordingPipeline:      recordingpipeline.NewService(nil),
		RecorderHealth:         recorderhealth.NewService(nil, time.Minute),
		RecorderMetrics:        testRecordingPipelineMetrics{},
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
		ChatAttachments:        chatService,
		ChatParticipants:       chatVerifier,
		WhiteboardFiles:        whiteboardService,
		WhiteboardParticipants: whiteboardVerifier,
	}
}
