package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
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
		return renderFailure{code: classifyIsolatedFailure(err), err: err}
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
		return renderFailure{code: classifyIsolatedFailure(err), err: err}
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
		return renderFailure{code: classifyIsolatedFailure(err), err: err}
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

func renderIsolatedEagerPage(ctx context.Context, executable, sourcePath, mimeType string, page int) ([]byte, int, int, error) {
	return renderIsolatedBitmap(ctx, executable, sourcePath, mimeType, page, standardEdge)
}

func renderIsolatedBitmap(ctx context.Context, executable, sourcePath, mimeType string, page, target int) ([]byte, int, int, error) {
	if mimeType == "application/pdf" {
		if err := renderIsolatedPDFPage(ctx, executable, sourcePath, page, target); err != nil {
			return nil, 0, 0, err
		}
		return readRenderedPage(sourcePath, page, target)
	}
	prefix := renderedPrefix(sourcePath, 1, 0)
	if err := runIsolatedChild(ctx, executable, "image", sourcePath, prefix); err != nil {
		return nil, 0, 0, err
	}
	return readRenderedPage(sourcePath, 1, 0)
}

func uploadEagerRenditions(ctx context.Context, assignment controlplane.Assignment, target controlplane.PageUploads, bitmap []byte, width, height int) error {
	standard, standardWidth, standardHeight, err := render.ResizeBGRA(bitmap, width, height, standardEdge)
	if err != nil {
		return err
	}
	thumbnail, thumbnailWidth, thumbnailHeight, err := render.ResizeBGRA(bitmap, width, height, thumbnailEdge)
	if err != nil {
		return err
	}
	standardEncodeStarted := time.Now()
	standardWebP, err := render.EncodeWebP(standard, standardWidth, standardHeight, webPQuality)
	if err != nil {
		return err
	}
	stageLog(ctx, assignment, target.Page, "webp_encode", time.Since(standardEncodeStarted), "target_edge", standardEdge, "object", "image")
	thumbnailEncodeStarted := time.Now()
	thumbnailWebP, err := render.EncodeWebP(thumbnail, thumbnailWidth, thumbnailHeight, webPQuality)
	if err != nil {
		return err
	}
	stageLog(ctx, assignment, target.Page, "webp_encode", time.Since(thumbnailEncodeStarted), "target_edge", thumbnailEdge, "object", "thumbnail")
	uploadStarted := time.Now()
	type uploadResult struct {
		object string
		bytes  int
		err    error
	}
	results := make(chan uploadResult, 2)
	go func() {
		results <- uploadResult{object: "image", bytes: len(standardWebP), err: upload(ctx, target.Image, standardWebP)}
	}()
	go func() {
		results <- uploadResult{object: "thumbnail", bytes: len(thumbnailWebP), err: upload(ctx, target.Thumbnail, thumbnailWebP)}
	}()
	var firstErr error
	for range 2 {
		result := <-results
		if result.err != nil && firstErr == nil {
			firstErr = result.err
		}
	}
	stageLog(ctx, assignment, target.Page, "upload", time.Since(uploadStarted), "object", "image+thumbnail", "bytes", len(standardWebP)+len(thumbnailWebP))
	return firstErr
}

func renderIsolatedPDFPage(ctx context.Context, executable, sourcePath string, page, target int) error {
	prefix := renderedPrefix(sourcePath, page, target)
	_ = os.Remove(prefix + ".raw")
	_ = os.Remove(prefix + ".json")
	return runIsolatedChild(ctx, executable, "page", sourcePath, prefix, strconv.Itoa(page), strconv.Itoa(target))
}

func runIsolatedChild(ctx context.Context, executable, mode string, args ...string) error {
	childCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	environment := []string{"RENDER_CHILD_MODE=" + mode}
	if libraryPath := os.Getenv("LD_LIBRARY_PATH"); libraryPath != "" {
		environment = append(environment, "LD_LIBRARY_PATH="+libraryPath)
	}
	newCommand := func(namespaces bool) *exec.Cmd {
		command := exec.CommandContext(childCtx, executable, args...)
		command.Env = environment
		if namespaces {
			configureIsolatedChild(command)
		} else {
			configureIsolatedChildWithoutNamespaces(command)
		}
		return command
	}
	output, err := newCommand(isolatedNamespacesEnabled()).CombinedOutput()
	if err != nil && childCtx.Err() == nil && isolatedNamespaceError(err) {
		disableIsolatedNamespaces()
		output, err = newCommand(false).CombinedOutput()
	}
	if childCtx.Err() == context.DeadlineExceeded {
		return fmt.Errorf("isolated %s render exceeded wall-clock limit", mode)
	}
	if err != nil {
		message := strings.TrimSpace(string(output))
		if len(message) > 160 {
			message = message[:160]
		}
		if message == "" {
			return fmt.Errorf("isolated %s render failed: %w", mode, err)
		}
		return fmt.Errorf("isolated %s render failed: %s", mode, message)
	}
	return nil
}

func classifyIsolatedFailure(err error) string {
	message := err.Error()
	if strings.Contains(message, "password") || strings.Contains(message, "pdfium error 4") {
		return "password_protected"
	}
	if strings.Contains(message, "exceed renderer bounds") || strings.Contains(message, "wall-clock") || strings.Contains(message, "memory") {
		return "too_large"
	}
	return "corrupt"
}

func readInventory(prefix string) ([]map[string]int, error) {
	encoded, err := os.ReadFile(prefix + ".inventory")
	if err != nil {
		return nil, err
	}
	var pages []map[string]int
	if err := json.Unmarshal(encoded, &pages); err != nil {
		return nil, err
	}
	_ = os.Remove(prefix + ".inventory")
	if len(pages) == 0 {
		return nil, fmt.Errorf("inventory child returned no pages")
	}
	return pages, nil
}

func readRenderedPage(sourcePath string, page, target int) ([]byte, int, int, error) {
	prefix := renderedPrefix(sourcePath, page, target)
	bitmap, err := os.ReadFile(prefix + ".raw")
	if err != nil {
		return nil, 0, 0, err
	}
	metadataBytes, err := os.ReadFile(prefix + ".json")
	if err != nil {
		return nil, 0, 0, err
	}
	var metadata struct{ Width, Height int }
	if err := json.Unmarshal(metadataBytes, &metadata); err != nil {
		return nil, 0, 0, err
	}
	_ = os.Remove(prefix + ".raw")
	_ = os.Remove(prefix + ".json")
	_ = os.Remove(prefix + ".timing")
	return bitmap, metadata.Width, metadata.Height, nil
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

func renderedPrefix(sourcePath string, page, target int) string {
	return filepath.Join(filepath.Dir(sourcePath), fmt.Sprintf("page-%d-%d", page, target))
}

func writeSource(source []byte) (string, func(), error) {
	directory, err := os.MkdirTemp("", "chalk-render-")
	if err != nil {
		return "", func() {}, err
	}
	path := filepath.Join(directory, "source")
	if err := os.WriteFile(path, source, 0o600); err != nil {
		os.RemoveAll(directory)
		return "", func() {}, err
	}
	return path, func() { os.RemoveAll(directory) }, nil
}

func finishFailure(ctx context.Context, control controlplane.ControlClient, assignment controlplane.Assignment, code string, cause error) error {
	if reportErr := control.Fail(ctx, assignment, code, cause.Error()); reportErr != nil {
		return fmt.Errorf("report render failure (%v): %w", cause, reportErr)
	}
	return nil
}
