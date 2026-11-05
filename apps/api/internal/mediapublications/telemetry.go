package mediapublications

import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

var publicationReconciliations, _ = otel.Meter("github.com/q9labs/chalk/apps/api/internal/mediapublications").Int64Counter(
	"chalk.media.publication_reconciliation",
	metric.WithDescription("Remote publication reconciliation outcomes from bounded provider evidence"),
)

var publicationClosuresSkipped, _ = otel.Meter("github.com/q9labs/chalk/apps/api/internal/mediapublications").Int64Counter(
	"chalk.media.publication_closure_skipped",
	metric.WithDescription("Publication closures skipped because Cloudflare lists the publisher track as active"),
)
