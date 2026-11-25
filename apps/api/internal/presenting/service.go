package presenting

import (
	"context"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
)

func (s Service) Create(ctx context.Context, subject Subject, attachmentID utilities.ID) (Document, error) {
	if s.repository == nil || !subject.IsComplete() || attachmentID.IsZero() {
		return Document{}, ErrInvalidInput
	}
	documentID, err := utilities.NewID()
	if err != nil {
		return Document{}, fmt.Errorf("generate presenting document id: %w", err)
	}
	document, err := s.repository.CreateDocument(ctx, subject, attachmentID, documentID)
	if err != nil {
		return Document{}, err
	}
	if !supportedMIMEType(document.MIMEType) {
		return Document{}, ErrUnsupportedType
	}
	if !document.Created {
		return document, nil
	}
	if document.InventoryJobID.IsZero() {
		return Document{}, fmt.Errorf("presenting document was created without an inventory job")
	}
	s.invoke(ctx, InvokeInput{JobID: document.InventoryJobID})
	return document, nil
}

func (s Service) Manifest(ctx context.Context, subject Subject, documentID utilities.ID) (Document, []Page, error) {
	if s.repository == nil || s.objects == nil || !subject.IsComplete() || documentID.IsZero() {
		return Document{}, nil, ErrInvalidInput
	}
	document, err := s.repository.AuthorizedDocument(ctx, subject, documentID)
	if err != nil {
		return Document{}, nil, err
	}
	pages, err := s.repository.ListPages(ctx, document)
	if err != nil {
		return Document{}, nil, err
	}
	for index := range pages {
		if pages[index].Status != "ready" {
			continue
		}
		if err := s.signPage(ctx, document, &pages[index]); err != nil {
			return Document{}, nil, err
		}
	}
	return document, pages, nil
}

func (s Service) Zoom(ctx context.Context, subject Subject, documentID utilities.ID, pageNumber int) (string, time.Time, error) {
	if s.repository == nil || s.objects == nil || !subject.IsComplete() || documentID.IsZero() || pageNumber < 1 || pageNumber > MaxPages {
		return "", time.Time{}, ErrInvalidInput
	}
	document, page, err := s.repository.AuthorizedPage(ctx, subject, documentID, pageNumber)
	if err != nil {
		return "", time.Time{}, err
	}
	if document.Status != "ready" && page.Status != "ready" {
		return "", time.Time{}, ErrDocumentNotReady
	}
	if !page.ZoomReady {
		job, created, err := s.repository.EnsureZoomJob(ctx, document, pageNumber, s.now().UTC())
		if err != nil {
			return "", time.Time{}, err
		}
		if !created {
			return "", time.Time{}, ErrZoomNotReady
		}
		if s.invoker == nil {
			return "", time.Time{}, ErrRenderUnavailable
		}
		if err := s.invoker.Invoke(ctx, InvokeInput{JobID: job.JobID, Synchronous: true}); err != nil {
			return "", time.Time{}, fmt.Errorf("invoke presenting zoom renderer: %w", err)
		}
		_, page, err = s.repository.AuthorizedPage(ctx, subject, documentID, pageNumber)
		if err != nil {
			return "", time.Time{}, err
		}
		if !page.ZoomReady {
			return "", time.Time{}, ErrZoomNotReady
		}
	}
	signed, err := s.objects.CreateDownloadURL(ctx, objectstorage.CreateDownloadURLInput{
		Key: page.ZoomKey, ExpiresIn: PageURLLifetime,
	})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("sign presenting zoom page: %w", err)
	}
	return signed.URL, signed.ExpiresAt, nil
}

func (s Service) signPage(ctx context.Context, document Document, page *Page) error {
	image, err := s.objects.CreateDownloadURL(ctx, objectstorage.CreateDownloadURLInput{
		Key: page.ImageKey, ExpiresIn: PageURLLifetime,
	})
	if err != nil {
		return fmt.Errorf("sign presenting page image: %w", err)
	}
	thumbnail, err := s.objects.CreateDownloadURL(ctx, objectstorage.CreateDownloadURLInput{
		Key: page.ThumbnailKey, ExpiresIn: PageURLLifetime,
	})
	if err != nil {
		return fmt.Errorf("sign presenting page thumbnail: %w", err)
	}
	page.ImageURL, page.ThumbnailURL, page.ExpiresAt = image.URL, thumbnail.URL, image.ExpiresAt
	return nil
}

func (s Service) invoke(ctx context.Context, input InvokeInput) {
	if s.invoker == nil {
		return
	}
	if journeyID, ok := observability.JourneyIDFromContext(ctx); ok {
		input.JourneyID = journeyID
	}
	if span := trace.SpanContextFromContext(ctx); span.IsValid() {
		input.Traceparent = "00-" + span.TraceID().String() + "-" + span.SpanID().String() + "-" + span.TraceFlags().String()
		input.Tracestate = span.TraceState().String()
	}
	if err := s.invoker.Invoke(ctx, input); err != nil {
		// The durable job remains queued; the renderer reconcile schedule is the backstop.
		_ = err
	}
}
