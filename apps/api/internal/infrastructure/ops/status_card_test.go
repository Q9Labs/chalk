package ops

import (
	"bytes"
	"image/png"
	"testing"
	"time"

	domainops "github.com/Q9Labs/chalk/internal/domain/ops"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/stretchr/testify/require"
)

func TestBuildPublicStatusCardPNG_ProducesDecodablePNG(t *testing.T) {
	summary := PublicStatusSummary{
		GeneratedAt: time.Date(2026, 4, 14, 16, 30, 0, 0, time.UTC),
		Overall:     domainops.ComponentStateOutage,
		Components: []PublicComponentStatus{
			{ID: "api", Name: "API", State: domainops.ComponentStateOutage},
			{ID: "web", Name: "Web App", State: domainops.ComponentStateDegraded},
			{ID: "workers", Name: "Workers", State: domainops.ComponentStateOperational},
		},
		ActiveIncidents: []db.OpsIncident{
			{Title: "API request failures"},
		},
	}

	data, err := BuildPublicStatusCardPNG(summary)
	require.NoError(t, err)
	require.NotEmpty(t, data)
	require.True(t, bytes.HasPrefix(data, []byte{0x89, 0x50, 0x4e, 0x47}))

	img, err := png.Decode(bytes.NewReader(data))
	require.NoError(t, err)
	require.Equal(t, statusCardWidth, img.Bounds().Dx())
	require.Equal(t, statusCardHeight, img.Bounds().Dy())
}

func TestBuildPublicStatusCardPNG_VariesByState(t *testing.T) {
	base := PublicStatusSummary{
		GeneratedAt: time.Date(2026, 4, 14, 16, 30, 0, 0, time.UTC),
		Components: []PublicComponentStatus{
			{ID: "api", Name: "API", State: domainops.ComponentStateOperational},
		},
	}

	operational := base
	operational.Overall = domainops.ComponentStateOperational

	outage := base
	outage.Overall = domainops.ComponentStateOutage

	imgA, err := BuildPublicStatusCardPNG(operational)
	require.NoError(t, err)

	imgB, err := BuildPublicStatusCardPNG(outage)
	require.NoError(t, err)

	require.NotEqual(t, imgA, imgB)
}
