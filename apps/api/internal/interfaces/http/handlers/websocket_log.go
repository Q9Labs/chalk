package handlers

import (
	"log/slog"

	applogging "github.com/Q9Labs/chalk/internal/infrastructure/logging"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
)

func wsBaseAttrs(c *gin.Context) []any {
	return []any{
		"request_id", middleware.GetRequestID(c),
		"path", c.Request.URL.Path,
		"client_ip", c.ClientIP(),
		"user_agent", c.GetHeader("User-Agent"),
		"origin", c.Request.Header.Get("Origin"),
	}
}

func wsInfo(msg string, attrs ...any) {
	slog.Info(msg, attrs...)
	if applogging.AxiomEnabled() {
		applogging.Stdout().Info(msg, attrs...)
	}
}

func wsWarn(msg string, attrs ...any) {
	slog.Warn(msg, attrs...)
	if applogging.AxiomEnabled() {
		applogging.Stdout().Warn(msg, attrs...)
	}
}

func wsError(msg string, attrs ...any) {
	slog.Error(msg, attrs...)
	if applogging.AxiomEnabled() {
		applogging.Stdout().Error(msg, attrs...)
	}
}
