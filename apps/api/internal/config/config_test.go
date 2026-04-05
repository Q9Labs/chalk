package config

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLoad_PostMeetingCloudflareFallsBackToGlobalConfig(t *testing.T) {
	t.Setenv("CLOUDFLARE_MOCK", "true")
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "global-account")
	t.Setenv("CLOUDFLARE_API_TOKEN", "global-token")

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, "global-account", cfg.PostMeeting.CloudflareAccountID)
	require.Equal(t, "global-token", cfg.PostMeeting.CloudflareAPIToken)
	require.Equal(t, "@cf/openai/whisper-large-v3-turbo", cfg.PostMeeting.CloudflareModel)
	require.Equal(t, "cloudflare", cfg.PostMeeting.TranscriptionDefaultProvider)
}

func TestLoad_PostMeetingCloudflareUsesOverrides(t *testing.T) {
	t.Setenv("CLOUDFLARE_MOCK", "true")
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "global-account")
	t.Setenv("CLOUDFLARE_API_TOKEN", "global-token")
	t.Setenv("POST_MEETING_CLOUDFLARE_ACCOUNT_ID", "post-account")
	t.Setenv("POST_MEETING_CLOUDFLARE_API_TOKEN", "post-token")
	t.Setenv("POST_MEETING_TRANSCRIPTION_DEFAULT_PROVIDER", "groq")

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, "post-account", cfg.PostMeeting.CloudflareAccountID)
	require.Equal(t, "post-token", cfg.PostMeeting.CloudflareAPIToken)
	require.Equal(t, "groq", cfg.PostMeeting.TranscriptionDefaultProvider)
}

func TestLoad_PostMeetingCloudflareWorkerConfig(t *testing.T) {
	t.Setenv("CLOUDFLARE_MOCK", "true")
	t.Setenv("POST_MEETING_CLOUDFLARE_WORKER_URL", "https://chalk-transcription.q9labs.ai")
	t.Setenv("POST_MEETING_CLOUDFLARE_WORKER_DISPATCH_SECRET", "dispatch-secret")
	t.Setenv("POST_MEETING_CLOUDFLARE_WORKER_CALLBACK_SECRET", "callback-secret")

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, "https://chalk-transcription.q9labs.ai", cfg.PostMeeting.CloudflareWorkerURL)
	require.Equal(t, "dispatch-secret", cfg.PostMeeting.CloudflareWorkerDispatchSecret)
	require.Equal(t, "callback-secret", cfg.PostMeeting.CloudflareWorkerCallbackSecret)
}
