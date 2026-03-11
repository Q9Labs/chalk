package http

import (
	"net/http"
	"testing"

	"github.com/Q9Labs/chalk/internal/config"
	"github.com/stretchr/testify/require"
)

func TestInternalAuthVerifyRouteSupportsMagicLinkClicks(t *testing.T) {
	router := NewRouter(RouterConfig{
		AppConfig: &config.Config{},
	})
	defer func() {
		require.NoError(t, router.Close())
	}()

	var hasGetVerify bool
	var hasPostVerify bool

	for _, route := range router.Engine().Routes() {
		if route.Path != "/api/v1/internal/auth/verify" {
			continue
		}

		switch route.Method {
		case http.MethodGet:
			hasGetVerify = true
		case http.MethodPost:
			hasPostVerify = true
		}
	}

	require.True(t, hasGetVerify, "expected GET /api/v1/internal/auth/verify route")
	require.True(t, hasPostVerify, "expected POST /api/v1/internal/auth/verify route")
}
