package http

import (
	"net/http"
	"testing"

	"github.com/Q9Labs/chalk/internal/config"
	"github.com/stretchr/testify/require"
)

func TestInternalAuthRoutesExposeGoogleSessionFlow(t *testing.T) {
	router := NewRouter(RouterConfig{
		AppConfig: &config.Config{},
	})
	defer func() {
		require.NoError(t, router.Close())
	}()

	var hasPostGoogle bool
	var hasGetSession bool
	var hasPostLogout bool
	var hasGetAccessToken bool

	for _, route := range router.Engine().Routes() {
		switch {
		case route.Path == "/api/v1/internal/auth/google" && route.Method == http.MethodPost:
			hasPostGoogle = true
		case route.Path == "/api/v1/internal/auth/session" && route.Method == http.MethodGet:
			hasGetSession = true
		case route.Path == "/api/v1/internal/auth/logout" && route.Method == http.MethodPost:
			hasPostLogout = true
		case route.Path == "/api/v1/internal/auth/access-token" && route.Method == http.MethodGet:
			hasGetAccessToken = true
		}
	}

	require.True(t, hasPostGoogle, "expected POST /api/v1/internal/auth/google route")
	require.True(t, hasGetSession, "expected GET /api/v1/internal/auth/session route")
	require.True(t, hasPostLogout, "expected POST /api/v1/internal/auth/logout route")
	require.True(t, hasGetAccessToken, "expected GET /api/v1/internal/auth/access-token route")
}

func TestAdminRoutesExposeWhisperJobs(t *testing.T) {
	router := NewRouter(RouterConfig{
		AppConfig: &config.Config{
			Admin: config.AdminConfig{
				Enabled: true,
			},
		},
	})
	defer func() {
		require.NoError(t, router.Close())
	}()

	var hasListWhisperJobs bool
	var hasProcessingWhisperJobs bool
	var hasWhisperJobStats bool

	for _, route := range router.Engine().Routes() {
		switch {
		case route.Path == "/api/v1/admin/whisper-jobs" && route.Method == http.MethodGet:
			hasListWhisperJobs = true
		case route.Path == "/api/v1/admin/whisper-jobs/processing" && route.Method == http.MethodGet:
			hasProcessingWhisperJobs = true
		case route.Path == "/api/v1/admin/whisper-jobs/stats" && route.Method == http.MethodGet:
			hasWhisperJobStats = true
		}
	}

	require.True(t, hasListWhisperJobs, "expected GET /api/v1/admin/whisper-jobs route")
	require.True(t, hasProcessingWhisperJobs, "expected GET /api/v1/admin/whisper-jobs/processing route")
	require.True(t, hasWhisperJobStats, "expected GET /api/v1/admin/whisper-jobs/stats route")
}
