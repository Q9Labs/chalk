package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	controlplane "github.com/q9labs/chalk/apps/document-renderer/internal/control"
	"github.com/q9labs/chalk/apps/document-renderer/internal/render"
)

const (
	standardEdge  = 1600
	thumbnailEdge = 240
	zoomEdge      = 3200
	webPQuality   = 78
)

func Process(ctx context.Context, control controlplane.ControlClient, assignment controlplane.Assignment) error {
	jobStarted := time.Now()
	defer func() { stageLog(ctx, assignment, 0, "job_total", time.Since(jobStarted)) }()
	downloadStarted := time.Now()
	source, err := download(ctx, assignment.SourceURL, assignment.SourceSizeBytes+1, assignment.SourceSHA256)
	if err != nil {
		return err
	}
	stageLog(ctx, assignment, 0, "source_download", time.Since(downloadStarted), "bytes", len(source))
	switch assignment.Kind {
	case "inventory":
		err = processInventory(ctx, control, assignment, source)
	case "pages":
		err = processPages(ctx, control, assignment, source)
	case "zoom":
		err = processZoom(ctx, control, assignment, source)
	case "timeout-probe":
		if os.Getenv("RENDERER_TIMEOUT_PROBE") != "1" {
			err = fmt.Errorf("timeout probe is disabled")
		} else {
			var executable string
			executable, err = os.Executable()
			if err == nil {
				childErr := runIsolatedChild(ctx, executable, "timeout-probe")
				if childErr != nil {
					err = renderFailure{code: classifyIsolatedFailure(childErr), err: childErr}
				}
			}
		}
	default:
		err = fmt.Errorf("unknown render job kind %q", assignment.Kind)
	}
	if err != nil {
		var failure renderFailure
		if errors.As(err, &failure) {
			return finishFailure(ctx, control, assignment, failure.code, failure.err)
		}
		return err
	}
	return nil
}

type renderFailure struct {
	code string
	err  error
}

func (f renderFailure) Error() string { return f.err.Error() }
func (f renderFailure) Unwrap() error { return f.err }

func isolatedRenderFailure(err error) error {
	var sandbox isolatedSandboxError
	if errors.As(err, &sandbox) {
		return renderFailure{code: "infrastructure", err: err}
	}
	return renderFailure{code: classifyIsolatedFailure(err), err: err}
}

func processInventory(ctx context.Context, control controlplane.ControlClient, assignment controlplane.Assignment, source []byte) error {
	sourcePath, cleanup, err := writeSource(source)
	if err != nil {
		return err
	}
	defer cleanup()
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	inventoryPrefix := renderedPrefix(sourcePath, 0, 0)
	inventoryStarted := time.Now()
	if err := runIsolatedChild(ctx, executable, "inventory", sourcePath, inventoryPrefix, assignment.MIMEType); err != nil {
		return isolatedRenderFailure(err)
	}
	logChildTiming(ctx, assignment, 0, "inventory", inventoryPrefix, time.Since(inventoryStarted))
	pageSpecs, err := readInventory(inventoryPrefix)
	if err != nil {
		return err
	}
	if len(pageSpecs) > 300 {
		return renderFailure{code: "too_many_pages", err: fmt.Errorf("document has %d pages", len(pageSpecs))}
	}
	renderStarted := time.Now()
	bitmap, width, height, err := renderIsolatedEagerPage(ctx, executable, sourcePath, assignment.MIMEType, 1)
	if err != nil {
		return isolatedRenderFailure(err)
	}
	logChildTiming(ctx, assignment, 1, "page", renderedPrefix(sourcePath, 1, standardEdge), time.Since(renderStarted))
	if err := uploadEagerRenditions(ctx, assignment, assignment.Uploads[0], bitmap, width, height); err != nil {
		return err
	}
	controlStarted := time.Now()
	if err := control.CompleteInventory(ctx, assignment, pageSpecs); err != nil {
		return fmt.Errorf("complete inventory: %w", err)
	}
	stageLog(ctx, assignment, 0, "inventory_complete_control", time.Since(controlStarted))
	return nil
}

func processPages(ctx context.Context, control controlplane.ControlClient, assignment controlplane.Assignment, source []byte) error {
	if assignment.MIMEType != "application/pdf" {
		return fmt.Errorf("image documents do not have page fanout jobs")
	}
	sourcePath, cleanup, err := writeSource(source)
	if err != nil {
		return err
	}
	defer cleanup()
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	semaphore := make(chan struct{}, 2)
	errorsChannel := make(chan error, len(assignment.Uploads))
	var wait sync.WaitGroup
	for _, target := range assignment.Uploads {
		target := target
		wait.Add(1)
		go func() {
			defer wait.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			renderStarted := time.Now()
			if err := renderIsolatedPDFPage(ctx, executable, sourcePath, target.Page, standardEdge); err != nil {
				errorsChannel <- err
				return
			}
			logChildTiming(ctx, assignment, target.Page, "page", renderedPrefix(sourcePath, target.Page, standardEdge), time.Since(renderStarted))
			bitmap, width, height, err := readRenderedPage(sourcePath, target.Page, standardEdge)
			if err != nil {
				errorsChannel <- err
				return
			}
			if err := uploadEagerRenditions(ctx, assignment, target, bitmap, width, height); err != nil {
				errorsChannel <- err
				return
			}
			if err := control.PageReady(ctx, assignment, target.Page); err != nil {
				errorsChannel <- err
			}
		}()
	}
	wait.Wait()
	close(errorsChannel)
	for err := range errorsChannel {
		if err != nil {
			return err
		}
	}
	controlStarted := time.Now()
	if err := control.Complete(ctx, assignment); err != nil {
		return fmt.Errorf("complete page job: %w", err)
	}
	stageLog(ctx, assignment, 0, "complete_control", time.Since(controlStarted))
	return nil
}

func processZoom(ctx context.Context, control controlplane.ControlClient, assignment controlplane.Assignment, source []byte) error {
	if len(assignment.Uploads) != 1 {
		return fmt.Errorf("zoom assignment does not name exactly one page")
	}
	target := assignment.Uploads[0]
	var bitmap []byte
	var width, height int
	var err error
	sourcePath, cleanup, err := writeSource(source)
	if err != nil {
		return err
	}
	defer cleanup()
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	renderStarted := time.Now()
	bitmap, width, height, err = renderIsolatedBitmap(ctx, executable, sourcePath, assignment.MIMEType, target.Page, zoomEdge)
	if err != nil {
		return isolatedRenderFailure(err)
	}
	logChildTiming(ctx, assignment, target.Page, "page", renderedPrefix(sourcePath, target.Page, zoomEdge), time.Since(renderStarted))
	resizeStarted := time.Now()
	bitmap, width, height, err = render.ResizeBGRA(bitmap, width, height, zoomEdge)
	if err != nil {
		return err
	}
	stageLog(ctx, assignment, target.Page, "resize", time.Since(resizeStarted), "target_edge", zoomEdge)
	encodeStarted := time.Now()
	encoded, err := render.EncodeWebP(bitmap, width, height, webPQuality)
	if err != nil {
		return err
	}
	stageLog(ctx, assignment, target.Page, "webp_encode", time.Since(encodeStarted), "target_edge", zoomEdge, "bytes", len(encoded), "quality", webPQuality)
	uploadStarted := time.Now()
	if err := upload(ctx, target.Zoom, encoded); err != nil {
		return err
	}
	stageLog(ctx, assignment, target.Page, "upload", time.Since(uploadStarted), "object", "zoom", "bytes", len(encoded))
	controlStarted := time.Now()
	if err := control.CompleteZoom(ctx, assignment, target.Page); err != nil {
		return fmt.Errorf("complete zoom render: %w", err)
	}
	stageLog(ctx, assignment, target.Page, "zoom_complete_control", time.Since(controlStarted))
	return nil
}

func stageLog(ctx context.Context, assignment controlplane.Assignment, page int, stage string, duration time.Duration, attrs ...any) {
	fields := []any{"event", "presenting.render.stage", "job_id", assignment.JobID, "document_id", assignment.DocumentID, "kind", assignment.Kind, "attempt", assignment.Attempt, "page", page, "stage", stage, "duration_ms", duration.Milliseconds()}
	fields = append(fields, attrs...)
	slog.Default().InfoContext(ctx, "presenting render stage", fields...)
}

func logChildTiming(ctx context.Context, assignment controlplane.Assignment, page int, mode, prefix string, wall time.Duration) {
	stageLog(ctx, assignment, page, mode+"_child_total", wall)
	encoded, err := os.ReadFile(prefix + ".timing")
	if err != nil {
		return
	}
	var timing render.ChildTiming
	if json.Unmarshal(encoded, &timing) != nil {
		return
	}
	spawn := wall - time.Duration(timing.TotalMs)*time.Millisecond
	if spawn < 0 {
		spawn = 0
	}
	stageLog(ctx, assignment, page, "child_spawn", spawn, "mode", mode)
	if timing.InputReadMs > 0 {
		stageLog(ctx, assignment, page, "child_input_read", time.Duration(timing.InputReadMs)*time.Millisecond)
	}
	if timing.DocumentOpenMs > 0 {
		stageLog(ctx, assignment, page, "document_open", time.Duration(timing.DocumentOpenMs)*time.Millisecond)
	}
	if timing.InventoryMs > 0 {
		stageLog(ctx, assignment, page, "inventory", time.Duration(timing.InventoryMs)*time.Millisecond)
	}
	if timing.PageLoadMs > 0 {
		stageLog(ctx, assignment, page, "page_load", time.Duration(timing.PageLoadMs)*time.Millisecond)
	}
	if timing.BitmapRenderMs > 0 {
		stageLog(ctx, assignment, page, "render_bitmap", time.Duration(timing.BitmapRenderMs)*time.Millisecond)
	}
	if timing.BitmapWriteMs > 0 {
		stageLog(ctx, assignment, page, "bitmap_write", time.Duration(timing.BitmapWriteMs)*time.Millisecond)
	}
}

func finishFailure(ctx context.Context, control controlplane.ControlClient, assignment controlplane.Assignment, code string, cause error) error {
	if reportErr := control.Fail(ctx, assignment, code, cause.Error()); reportErr != nil {
		return fmt.Errorf("report render failure (%v): %w", cause, reportErr)
	}
	var compromise isolatedChildCompromiseError
	if errors.As(cause, &compromise) {
		return fmt.Errorf("isolated parser failure reported; recycling renderer process: %w", cause)
	}
	return nil
}
