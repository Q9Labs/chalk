package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	controlplane "github.com/q9labs/chalk/apps/document-renderer/internal/control"
	"github.com/q9labs/chalk/apps/document-renderer/internal/office"
)

// Office jobs convert the source to PDF inside the isolated "office" child
// and then continue as ordinary PDF jobs. Every job (inventory, pages, zoom)
// converts again statelessly, so the page count can only match when LibreOffice
// lays the document out the same way each time; verifyConvertedPages rejects a
// pages or zoom job whose converted PDF is shorter than the page it must render.
func convertOffice(ctx context.Context, source []byte, mimeType string) ([]byte, error) {
	sourcePath, cleanup, err := writeSource(source)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	prefix := renderedPrefix(sourcePath, 0, 0)
	started := time.Now()
	if err := runIsolatedChildWithTimeout(ctx, office.ConvertTimeout, executable, "office", sourcePath, prefix, mimeType); err != nil {
		return nil, isolatedRenderFailure(err)
	}
	slog.Default().InfoContext(ctx, "presenting office conversion", "event", "presenting.render.office", "mime_type", mimeType, "duration_ms", time.Since(started).Milliseconds())
	return os.ReadFile(prefix + ".pdf")
}

func verifyConvertedPages(ctx context.Context, converted bool, executable, sourcePath string, lastPage int) error {
	if !converted {
		return nil
	}
	prefix := renderedPrefix(sourcePath, 0, 0)
	if err := runIsolatedChild(ctx, executable, "inventory", sourcePath, prefix, "application/pdf"); err != nil {
		return isolatedRenderFailure(err)
	}
	pages, err := readInventory(prefix)
	if err != nil {
		return err
	}
	if lastPage > len(pages) {
		return renderFailure{code: "infrastructure", err: fmt.Errorf("converted document has %d pages but the job renders page %d: conversion is not deterministic", len(pages), lastPage)}
	}
	return nil
}

func lastUploadPage(uploads []controlplane.PageUploads) int {
	last := 0
	for _, upload := range uploads {
		last = max(last, upload.Page)
	}
	return last
}

func prepareSource(ctx context.Context, source []byte, assignment *controlplane.Assignment) ([]byte, bool, error) {
	if _, isOffice := office.Lookup(assignment.MIMEType); !isOffice || assignment.Kind == "timeout-probe" {
		return source, false, nil
	}
	pdf, err := convertOffice(ctx, source, assignment.MIMEType)
	if err != nil {
		return nil, false, err
	}
	assignment.MIMEType = "application/pdf"
	return pdf, true, nil
}

func tooManyPages(pages int, converted bool) error {
	if converted {
		return renderFailure{code: office.CodeTooManyPages, err: errors.New(office.TooManyPagesMessage())}
	}
	return renderFailure{code: office.CodeTooManyPages, err: fmt.Errorf("document has %d pages", pages)}
}

func reportFailure(ctx context.Context, control controlplane.ControlClient, assignment controlplane.Assignment, err error) error {
	var failure renderFailure
	if errors.As(err, &failure) {
		return finishFailure(ctx, control, assignment, failure.code, failure.err)
	}
	return err
}
