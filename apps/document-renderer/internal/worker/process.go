package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/q9labs/chalk/apps/document-renderer/internal/render"
	_ "golang.org/x/image/webp"
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
		return finishFailure(ctx, control, assignment, "source_unavailable", err)
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
		return finishFailure(ctx, control, assignment, "render_failed", err)
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
	pageSpecs := []map[string]int{}
	if assignment.MIMEType == "application/pdf" {
		inventory, failureCode, err := render.PDFInventoryFromBytes(source)
		if err != nil {
			return renderFailure{code: failureCode, err: err}
		}
		for _, page := range inventory.Pages {
			pageSpecs = append(pageSpecs, map[string]int{"page": len(pageSpecs) + 1, "width": page.Width, "height": page.Height})
		}
	} else {
		width, height, err := imageDimensions(source)
		if err != nil {
			return renderFailure{code: "corrupt", err: err}
		}
		width, height = render.ScaledDimensions(width, height, standardEdge)
		pageSpecs = append(pageSpecs, map[string]int{"page": 1, "width": width, "height": height})
	}
	if len(pageSpecs) > 300 {
		return renderFailure{code: "too_many_pages", err: fmt.Errorf("document has %d pages", len(pageSpecs))}
	}
	if err := renderAndUploadEagerPage(ctx, assignment, source, 1, assignment.Uploads[0]); err != nil {
		return err
	}
	if err := control.CompleteInventory(ctx, assignment, pageSpecs); err != nil {
		return fmt.Errorf("complete inventory: %w", err)
	}
	if err := control.PageReady(ctx, assignment, 1); err != nil {
		return fmt.Errorf("report first page: %w", err)
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
	var failureCode string
	var err error
	if assignment.MIMEType == "application/pdf" {
		bitmap, width, height, failureCode, err = render.RenderPDFPage(source, target.Page, zoomEdge)
		if err != nil {
			return renderFailure{code: failureCode, err: err}
		}
	} else {
		bitmap, width, height, err = decodeImageBGRA(source)
		if err != nil {
			return renderFailure{code: "corrupt", err: err}
		}
		bitmap, width, height, err = render.ResizeBGRA(bitmap, width, height, zoomEdge)
		if err != nil {
			return err
		}
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

func renderAndUploadEagerPage(ctx context.Context, assignment Assignment, source []byte, page int, target pageUploads) error {
	var bitmap []byte
	var width, height int
	var failureCode string
	var err error
	if assignment.MIMEType == "application/pdf" {
		bitmap, width, height, failureCode, err = render.RenderPDFPage(source, page, standardEdge)
		if err != nil {
			return renderFailure{code: failureCode, err: err}
		}
	} else {
		bitmap, width, height, err = decodeImageBGRA(source)
		if err != nil {
			return renderFailure{code: "corrupt", err: err}
		}
	}
	return uploadEagerRenditions(ctx, target, bitmap, width, height)
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
	command := exec.CommandContext(ctx, executable, sourcePath, prefix, strconv.Itoa(page), strconv.Itoa(target))
	command.Env = append(os.Environ(), "RENDER_PAGE_MODE=1")
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("render page %d in isolated process: %w: %s", page, err, string(output))
	}
	return nil
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

func imageDimensions(source []byte) (int, int, error) {
	config, _, err := image.DecodeConfig(bytes.NewReader(source))
	return config.Width, config.Height, err
}

func decodeImageBGRA(source []byte) ([]byte, int, int, error) {
	decoded, _, err := image.Decode(bytes.NewReader(source))
	if err != nil {
		return nil, 0, 0, err
	}
	bounds := decoded.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width < 1 || height < 1 || width > 12000 || height > 12000 {
		return nil, 0, 0, fmt.Errorf("invalid image dimensions %dx%d", width, height)
	}
	output := make([]byte, width*height*4)
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			r, g, b, a := decoded.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()
			offset := (y*width + x) * 4
			output[offset] = byte(b >> 8)
			output[offset+1] = byte(g >> 8)
			output[offset+2] = byte(r >> 8)
			output[offset+3] = byte(a >> 8)
		}
	}
	return output, width, height, nil
}

func finishFailure(ctx context.Context, control ControlClient, assignment Assignment, code string, cause error) error {
	if reportErr := control.Fail(ctx, assignment, code, cause.Error()); reportErr != nil {
		return fmt.Errorf("report render failure (%v): %w", cause, reportErr)
	}
	return nil
}
