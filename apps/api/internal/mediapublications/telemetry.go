package mediapublications

import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

var publicationReconciliations, _ = otel.Meter("github.com/q9labs/chalk/apps/api/internal/mediapublications").Int64Counter(
	"chalk.media.publication_reconciliation",
	metric.WithDescription("Remote publication reconciliation outcomes from bounded provider evidence"),
)
