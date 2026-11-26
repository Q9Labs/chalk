package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	controlplane "github.com/q9labs/chalk/apps/document-renderer/internal/control"
	"github.com/q9labs/chalk/apps/document-renderer/internal/render"
)

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

type isolatedChildCompromiseError struct{ err error }

func (e isolatedChildCompromiseError) Error() string { return e.err.Error() }
func (e isolatedChildCompromiseError) Unwrap() error { return e.err }

func runIsolatedChild(ctx context.Context, executable, mode string, args ...string) error {
	childCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	environment := []string{"RENDER_CHILD_MODE=" + mode}
	if libraryPath := os.Getenv("LD_LIBRARY_PATH"); libraryPath != "" {
		environment = append(environment, "LD_LIBRARY_PATH="+libraryPath)
	}
	command := exec.Command(executable, args...)
	command.Env = environment
	configureIsolatedChild(command)
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Start(); err != nil {
		return fmt.Errorf("start isolated %s render sandbox: %w", mode, err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	var err error
	select {
	case err = <-done:
	case <-childCtx.Done():
		killIsolatedChildProcessGroup(command)
		<-done
		if childCtx.Err() == context.DeadlineExceeded {
			return isolatedChildCompromiseError{err: fmt.Errorf("isolated %s render exceeded wall-clock limit", mode)}
		}
		return fmt.Errorf("isolated %s render interrupted: %w", mode, childCtx.Err())
	}
	if err != nil {
		message := strings.TrimSpace(output.String())
		if len(message) > 160 {
			message = message[:160]
		}
		if message == "" {
			return isolatedChildCompromiseError{err: fmt.Errorf("isolated %s render failed: %w", mode, err)}
		}
		return isolatedChildCompromiseError{err: fmt.Errorf("isolated %s render failed: %s", mode, message)}
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
