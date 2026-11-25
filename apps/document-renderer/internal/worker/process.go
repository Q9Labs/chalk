package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/document-renderer/internal/render"
)

const (
	standardEdge  = 1600
	thumbnailEdge = 240
	zoomEdge      = 3200
	webPQuality   = 78
)

func Process(ctx context.Context, control ControlClient, assignment Assignment) error {
	source, err := download(ctx, assignment.SourceURL, assignment.SourceSizeBytes+1, assignment.SourceSHA256)
	if err != nil {
		return err
	}
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

func processInventory(ctx context.Context, control ControlClient, assignment Assignment, source []byte) error {
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
	if err := runIsolatedChild(ctx, executable, "inventory", sourcePath, inventoryPrefix, assignment.MIMEType); err != nil {
		return renderFailure{code: classifyIsolatedFailure(err), err: err}
	}
	pageSpecs, err := readInventory(inventoryPrefix)
	if err != nil {
		return err
	}
	if len(pageSpecs) > 300 {
		return renderFailure{code: "too_many_pages", err: fmt.Errorf("document has %d pages", len(pageSpecs))}
	}
	bitmap, width, height, err := renderIsolatedEagerPage(ctx, executable, sourcePath, assignment.MIMEType, 1)
	if err != nil {
		return renderFailure{code: classifyIsolatedFailure(err), err: err}
	}
	if err := uploadEagerRenditions(ctx, assignment.Uploads[0], bitmap, width, height); err != nil {
		return err
	}
	if err := control.CompleteInventory(ctx, assignment, pageSpecs); err != nil {
		return fmt.Errorf("complete inventory: %w", err)
	}
	return nil
}

func processPages(ctx context.Context, control ControlClient, assignment Assignment, source []byte) error {
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
			if err := renderIsolatedPDFPage(ctx, executable, sourcePath, target.Page, standardEdge); err != nil {
				errorsChannel <- err
				return
			}
			bitmap, width, height, err := readRenderedPage(sourcePath, target.Page, standardEdge)
			if err != nil {
				errorsChannel <- err
				return
			}
			if err := uploadEagerRenditions(ctx, target, bitmap, width, height); err != nil {
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
	if err := control.Complete(ctx, assignment); err != nil {
		return fmt.Errorf("complete page job: %w", err)
	}
	return nil
}

func processZoom(ctx context.Context, control ControlClient, assignment Assignment, source []byte) error {
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
	bitmap, width, height, err = renderIsolatedBitmap(ctx, executable, sourcePath, assignment.MIMEType, target.Page, zoomEdge)
	if err != nil {
		return renderFailure{code: classifyIsolatedFailure(err), err: err}
	}
	bitmap, width, height, err = render.ResizeBGRA(bitmap, width, height, zoomEdge)
	if err != nil {
		return err
	}
	encoded, err := render.EncodeWebP(bitmap, width, height, webPQuality)
	if err != nil {
		return err
	}
	if err := upload(ctx, target.Zoom, encoded); err != nil {
		return err
	}
	if err := control.CompleteZoom(ctx, assignment, target.Page); err != nil {
		return fmt.Errorf("complete zoom render: %w", err)
	}
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

func uploadEagerRenditions(ctx context.Context, target pageUploads, bitmap []byte, width, height int) error {
	standard, standardWidth, standardHeight, err := render.ResizeBGRA(bitmap, width, height, standardEdge)
	if err != nil {
		return err
	}
	thumbnail, thumbnailWidth, thumbnailHeight, err := render.ResizeBGRA(bitmap, width, height, thumbnailEdge)
	if err != nil {
		return err
	}
	standardWebP, err := render.EncodeWebP(standard, standardWidth, standardHeight, webPQuality)
	if err != nil {
		return err
	}
	thumbnailWebP, err := render.EncodeWebP(thumbnail, thumbnailWidth, thumbnailHeight, webPQuality)
	if err != nil {
		return err
	}
	if err := upload(ctx, target.Image, standardWebP); err != nil {
		return err
	}
	return upload(ctx, target.Thumbnail, thumbnailWebP)
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
	command := exec.CommandContext(childCtx, executable, args...)
	environment := []string{"RENDER_CHILD_MODE=" + mode}
	if libraryPath := os.Getenv("LD_LIBRARY_PATH"); libraryPath != "" {
		environment = append(environment, "LD_LIBRARY_PATH="+libraryPath)
	}
	command.Env = environment
	configureIsolatedChild(command)
	output, err := command.CombinedOutput()
	if childCtx.Err() == context.DeadlineExceeded {
		return fmt.Errorf("isolated %s render exceeded wall-clock limit", mode)
	}
	if err != nil {
		message := strings.TrimSpace(string(output))
		if len(message) > 160 {
			message = message[:160]
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
	return bitmap, metadata.Width, metadata.Height, nil
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

func finishFailure(ctx context.Context, control ControlClient, assignment Assignment, code string, cause error) error {
	if reportErr := control.Fail(ctx, assignment, code, cause.Error()); reportErr != nil {
		return fmt.Errorf("report render failure (%v): %w", cause, reportErr)
	}
	return nil
}
