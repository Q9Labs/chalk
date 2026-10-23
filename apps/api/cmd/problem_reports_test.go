package main

import (
	"strings"
	"testing"
)

func TestInvalidProblemReportWebhookFailsBeforeInfrastructure(t *testing.T) {
	t.Setenv("CHALK_API_ENV", "local")
	t.Setenv("CHALK_DATABASE_URL", "postgres://127.0.0.1:1/chalk?sslmode=disable&connect_timeout=1")
	t.Setenv("CHALK_PROBLEM_REPORTS_DISCORD_WEBHOOK_URL", "http://discord.com/api/webhooks/fixture/private-webhook-token")
	err := run()
	if err == nil || !strings.Contains(err.Error(), "CHALK_PROBLEM_REPORTS_DISCORD_WEBHOOK_URL") {
		t.Fatalf("expected a webhook configuration error before infrastructure startup; got %v", err)
	}
	if strings.Contains(err.Error(), "private-webhook-token") || strings.Contains(err.Error(), "http://") {
		t.Fatal("startup error exposed the configured webhook URL")
	}
}
