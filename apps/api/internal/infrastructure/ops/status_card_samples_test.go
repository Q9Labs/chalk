package ops

import (
	"os"
	"testing"
	"time"

	domainops "github.com/Q9Labs/chalk/internal/domain/ops"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
)

func TestGenerateStatusCardSamples(t *testing.T) {
	uptime99 := 99.9
	uptime95 := 95.5
	uptime100 := 100.0

	testCases := []struct {
		name    string
		summary PublicStatusSummary
	}{
		{
			name: "operational",
			summary: PublicStatusSummary{
				GeneratedAt: time.Date(2026, 4, 14, 16, 30, 0, 0, time.UTC),
				Overall:     domainops.ComponentStateOperational,
				Components: []PublicComponentStatus{
					{ID: "api", Name: "API", State: domainops.ComponentStateOperational, RecentUptimePct: &uptime100},
					{ID: "web", Name: "Web App", State: domainops.ComponentStateOperational, RecentUptimePct: &uptime99},
					{ID: "workers", Name: "Workers", State: domainops.ComponentStateOperational, RecentUptimePct: &uptime99},
				},
			},
		},
		{
			name: "degraded",
			summary: PublicStatusSummary{
				GeneratedAt: time.Date(2026, 4, 14, 16, 30, 0, 0, time.UTC),
				Overall:     domainops.ComponentStateDegraded,
				Components: []PublicComponentStatus{
					{ID: "api", Name: "API", State: domainops.ComponentStateOperational, RecentUptimePct: &uptime99},
					{ID: "web", Name: "Web App", State: domainops.ComponentStateDegraded, RecentUptimePct: &uptime95},
					{ID: "workers", Name: "Workers", State: domainops.ComponentStateOperational, RecentUptimePct: &uptime99},
				},
				ActiveIncidents: []db.OpsIncident{
					{
						Title:         "Elevated latency on Web App",
						PublicMessage: ptr("Some users may experience slower load times"),
						ComponentIds:  []string{"web"},
					},
				},
			},
		},
		{
			name: "outage",
			summary: PublicStatusSummary{
				GeneratedAt: time.Date(2026, 4, 14, 16, 30, 0, 0, time.UTC),
				Overall:     domainops.ComponentStateOutage,
				Components: []PublicComponentStatus{
					{ID: "api", Name: "API", State: domainops.ComponentStateOutage, RecentUptimePct: &uptime95},
					{ID: "web", Name: "Web App", State: domainops.ComponentStateOutage, RecentUptimePct: &uptime95},
					{ID: "workers", Name: "Workers", State: domainops.ComponentStateOperational, RecentUptimePct: &uptime99},
				},
				ActiveIncidents: []db.OpsIncident{
					{
						Title:         "API Service Disruption",
						PublicMessage: ptr("We are investigating elevated error rates"),
						ComponentIds:  []string{"api", "web"},
					},
				},
			},
		},
		{
			name: "maintenance",
			summary: PublicStatusSummary{
				GeneratedAt: time.Date(2026, 4, 14, 16, 30, 0, 0, time.UTC),
				Overall:     domainops.ComponentStateMaintenance,
				Components: []PublicComponentStatus{
					{ID: "api", Name: "API", State: domainops.ComponentStateMaintenance, RecentUptimePct: &uptime100},
					{ID: "web", Name: "Web App", State: domainops.ComponentStateOperational, RecentUptimePct: &uptime99},
					{ID: "workers", Name: "Workers", State: domainops.ComponentStateOperational, RecentUptimePct: &uptime99},
				},
				Maintenance: []db.OpsMaintenanceWindow{
					{
						Title:         "Database Maintenance",
						PublicMessage: ptr("Scheduled database upgrades"),
						EndsAt:        time.Date(2026, 4, 14, 18, 0, 0, 0, time.UTC),
					},
				},
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			data, err := BuildPublicStatusCardPNG(tc.summary)
			if err != nil {
				t.Fatalf("Failed to generate status card: %v", err)
			}

			filename := "/tmp/status_card_" + tc.name + ".png"
			if err := os.WriteFile(filename, data, 0644); err != nil {
				t.Fatalf("Failed to write PNG: %v", err)
			}
			t.Logf("Generated: %s", filename)
		})
	}
}

func ptr(s string) *string {
	return &s
}
