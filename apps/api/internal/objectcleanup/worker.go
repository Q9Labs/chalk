// Package objectcleanup deletes stored objects whose database rows ended, in leased batches.
// Chat attachments and whiteboard files each bind it to their own claim type and telemetry names.
package objectcleanup

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

const (
	// Retention is how long an ended row keeps its object before cleanup claims it.
	Retention     = 7 * 24 * time.Hour
	leaseDuration = 5 * time.Minute
	batchSize     = 50
	maxBatches    = 4
)

var (
	ErrInvalidConfig = errors.New("invalid object cleanup configuration")
	// ErrLeaseLost is returned by a repository when another worker took the claim.
	ErrLeaseLost = errors.New("object cleanup lease lost")
)

// Kind names the stored thing for telemetry and logs.
type Kind struct {
	// Name is the snake_case telemetry name, such as "chat_attachments".
	Name string
	// Label is the human name used in messages, such as "chat attachment".
	Label string
	// Scope is the instrumentation scope, the import path of the package that owns the objects.
	Scope string
}

type ClaimInput struct {
	Now         time.Time
	EndedBefore time.Time
	LeaseUntil  time.Time
	Limit       int
}

// Repository claims ended rows with a lease and completes a claim once its object is gone.
type Repository[C any] interface {
	ClaimCleanup(context.Context, ClaimInput) ([]C, error)
	CompleteCleanup(context.Context, C) error
}

type ObjectDeleter interface {
	DeleteObject(context.Context, string) error
}

type Result struct {
	Batches int
	Claimed int
	Deleted int
	Failed  int
}

type Worker[C any] struct {
	kind       Kind
	repository Repository[C]
	objects    ObjectDeleter
	objectKey  func(C) string
	now        func() time.Time
	tracer     trace.Tracer
	runs       metric.Int64Counter
	deletions  metric.Int64Counter
}

func NewWorker[C any](kind Kind, repository Repository[C], objects ObjectDeleter, objectKey func(C) string) Worker[C] {
	meter := otel.Meter(kind.Scope)
	runs, _ := meter.Int64Counter("chalk.api."+kind.Name+".cleanup.runs", metric.WithUnit("{run}"))
	deletions, _ := meter.Int64Counter("chalk.api."+kind.Name+".cleanup.objects", metric.WithUnit("{object}"))
	return Worker[C]{
		kind: kind, repository: repository, objects: objects, objectKey: objectKey, now: time.Now,
		tracer: otel.Tracer(kind.Scope), runs: runs, deletions: deletions,
	}
}

func (w Worker[C]) Kind() Kind { return w.kind }

func (w Worker[C]) Run(ctx context.Context) (result Result, resultErr error) {
	if w.tracer == nil {
		return result, ErrInvalidConfig
	}
	ctx, span := w.tracer.Start(ctx, w.kind.Name+".cleanup")
	defer func() {
		w.finish(ctx, span, result, resultErr)
	}()

	if w.repository == nil || w.objects == nil || w.objectKey == nil || w.now == nil {
		return result, ErrInvalidConfig
	}
	now := w.now().UTC()
	input := ClaimInput{Now: now, EndedBefore: now.Add(-Retention), LeaseUntil: now.Add(leaseDuration), Limit: batchSize}
	var failures []error
	for result.Batches < maxBatches {
		if err := ctx.Err(); err != nil {
			return result, errors.Join(errors.Join(failures...), err)
		}
		claims, err := w.repository.ClaimCleanup(ctx, input)
		result.Batches++
		if err != nil {
			return result, errors.Join(errors.Join(failures...), fmt.Errorf("claim %s cleanup: %w", w.kind.Label, err))
		}
		result.Claimed += len(claims)
		for _, claim := range claims {
			outcome, err := w.deleteClaim(ctx, claim)
			w.deletions.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", outcome)))
			if err != nil {
				result.Failed++
				failures = append(failures, err)
				continue
			}
			result.Deleted++
		}
		if len(claims) < batchSize {
			break
		}
	}
	return result, errors.Join(failures...)
}

func (w Worker[C]) deleteClaim(ctx context.Context, claim C) (string, error) {
	outcome := "deleted"
	err := w.objects.DeleteObject(ctx, w.objectKey(claim))
	if errors.Is(err, objectstorage.ErrObjectNotFound) {
		outcome = "already_absent"
	} else if err != nil {
		return "delete_failed", fmt.Errorf("delete %s object: %w", w.kind.Label, err)
	}
	if err := w.repository.CompleteCleanup(ctx, claim); err != nil {
		return "complete_failed", fmt.Errorf("complete %s cleanup: %w", w.kind.Label, err)
	}
	return outcome, nil
}

func (w Worker[C]) finish(ctx context.Context, span trace.Span, result Result, err error) {
	outcome := "succeeded"
	if err != nil {
		outcome = "failed"
		span.RecordError(err)
		span.SetStatus(codes.Error, w.kind.Label+" cleanup failed")
	}
	prefix := "chalk." + w.kind.Name + ".cleanup."
	span.SetAttributes(
		attribute.String(prefix+"outcome", outcome),
		attribute.Int(prefix+"batches", result.Batches),
		attribute.Int(prefix+"claimed", result.Claimed),
		attribute.Int(prefix+"deleted", result.Deleted),
		attribute.Int(prefix+"failed", result.Failed),
	)
	w.runs.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", outcome)))
	span.End()
}
