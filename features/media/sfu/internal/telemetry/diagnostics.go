package telemetry

import (
	"context"
	"sync/atomic"

	sdklog "go.opentelemetry.io/otel/sdk/log"
)

// Drop reasons name why the log export lost a record or a field. They are the values of the
// chalk.sfu.telemetry.dropped metric's reason attribute.
const (
	DropQueueFull     = "queue_full"     // the export was behind and held its limit of records
	DropExportFailed  = "export_failed"  // the store refused or never got the batch
	DropFieldRejected = "field_rejected" // a field failed its source check, so the event left without it
)

// exportQueueLimit is the most records the log export holds between the node's logger and the
// store. Past it the node drops the newest and counts it, so a slow store costs a bounded amount of
// memory and every loss is counted instead of discarded by the SDK without a word.
const exportQueueLimit = 2048

// Diagnostics is what the log export knows about itself: whether it runs and what it lost.
// The node reads it into metrics, because a trail that fails silently is worse than a trail that
// is missing.
type Diagnostics struct {
	logsExport                                           atomic.Bool
	queueFull, exportFailed, fieldRejected, exportErrors atomic.Uint64
}

// LogsExport reports whether the diagnosis trail leaves the node.
func (d *Diagnostics) LogsExport() bool { return d.logsExport.Load() }

// Dropped is the count of records or fields lost for a reason since start.
func (d *Diagnostics) Dropped(reason string) uint64 {
	switch reason {
	case DropQueueFull:
		return d.queueFull.Load()
	case DropExportFailed:
		return d.exportFailed.Load()
	case DropFieldRejected:
		return d.fieldRejected.Load()
	}
	return 0
}

// ExportErrors is the count of failed export batches, logs and metrics together.
func (d *Diagnostics) ExportErrors() uint64 { return d.exportErrors.Load() }

// boundedProcessor puts a counted limit in front of the batch processor. The SDK's own queue drops
// the newest record when it is full and reports nothing. Here at most exportQueueLimit records are
// between emit and export (held[0] counts them), the batch queue is larger than that so it never
// fills, and a record refused at the limit is counted.
type boundedProcessor struct {
	*sdklog.BatchProcessor
	held *atomic.Int64
	diag *Diagnostics
}

func (p boundedProcessor) OnEmit(ctx context.Context, record *sdklog.Record) error {
	if p.held.Add(1) > exportQueueLimit {
		p.held.Add(-1)
		p.diag.queueFull.Add(1)
		return nil
	}
	return p.BatchProcessor.OnEmit(ctx, record)
}

// countingExporter releases the records a batch held once the store has answered, and counts the
// ones it lost.
type countingExporter struct {
	sdklog.Exporter
	held *atomic.Int64
	diag *Diagnostics
}

func (e countingExporter) Export(ctx context.Context, records []sdklog.Record) error {
	err := e.Exporter.Export(ctx, records)
	e.held.Add(-int64(len(records)))
	if err != nil {
		e.diag.exportFailed.Add(uint64(len(records)))
	}
	return err
}
