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
	"sync"
	"time"

	controlplane "github.com/q9labs/chalk/apps/document-renderer/internal/control"
	"github.com/q9labs/chalk/apps/document-renderer/internal/office"
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

type isolatedSandboxError struct{ err error }

func (e isolatedSandboxError) Error() string { return e.err.Error() }
func (e isolatedSandboxError) Unwrap() error { return e.err }

type cappedChildOutput struct {
	mu  sync.Mutex
	out bytes.Buffer
}

func (o *cappedChildOutput) appendChunk(chunk []byte) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if remaining := 4096 - o.out.Len(); remaining > 0 {
		o.out.Write(chunk[:min(len(chunk), remaining)])
	}
}

func (o *cappedChildOutput) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.out.String()
}

func collectChildOutput(pipe *os.File, output *cappedChildOutput, done chan<- struct{}) {
	defer close(done)
	chunk := make([]byte, 4096)
	for {
		n, err := pipe.Read(chunk)
		if n > 0 {
			output.appendChunk(chunk[:n])
		}
		if err != nil {
			return
		}
	}
}

func closePipe(pipe *os.File) {
	if pipe != nil {
		_ = pipe.Close()
	}
}

func runIsolatedChild(ctx context.Context, executable, mode string, args ...string) error {
	return runIsolatedChildWithTimeout(ctx, 20*time.Second, executable, mode, args...)
}

func runIsolatedChildWithTimeout(ctx context.Context, timeout time.Duration, executable, mode string, args ...string) error {
	childCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	environment := isolatedChildEnvironment(mode)
	command := exec.Command(executable, args...)
	command.Env = environment
	configureIsolatedChild(command, useIsolatedNamespaces())
	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		return fmt.Errorf("create isolated %s stdout pipe: %w", mode, err)
	}
	stderrRead, stderrWrite, err := os.Pipe()
	if err != nil {
		closePipe(stdoutRead)
		closePipe(stdoutWrite)
		return fmt.Errorf("create isolated %s stderr pipe: %w", mode, err)
	}
	command.Stdout = stdoutWrite
	command.Stderr = stderrWrite
	if err := command.Start(); err != nil {
		closePipe(stdoutRead)
		closePipe(stdoutWrite)
		closePipe(stderrRead)
		closePipe(stderrWrite)
		return isolatedSandboxError{err: fmt.Errorf("start isolated %s render sandbox: %w", mode, err)}
	}
	closePipe(stdoutWrite)
	closePipe(stderrWrite)
	pgid := isolatedChildProcessGroupID(command.Process.Pid)
	output := &cappedChildOutput{}
	stdoutDone, stderrDone := make(chan struct{}), make(chan struct{})
	go collectChildOutput(stdoutRead, output, stdoutDone)
	go collectChildOutput(stderrRead, output, stderrDone)
	readerDone := make(chan struct{})
	go func() {
		<-stdoutDone
		<-stderrDone
		close(readerDone)
	}()
	waitDone := make(chan error, 1)
	go func() { waitDone <- command.Wait() }()

	var waitErr error
	interrupted := false
	select {
	case waitErr = <-waitDone:
	case <-childCtx.Done():
		interrupted = true
	}

	// A parser child can spawn descendants and then exit successfully. Always
	// kill the whole group before trusting the result, not only after a timeout.
	killIsolatedChildProcessGroup(pgid, command.Process)
	if interrupted {
		closePipe(stdoutRead)
		closePipe(stderrRead)
		select {
		case waitErr = <-waitDone:
		case <-time.After(2 * time.Second):
		}
		select {
		case <-readerDone:
		case <-time.After(200 * time.Millisecond):
		}
		if childCtx.Err() == context.DeadlineExceeded {
			return isolatedChildCompromiseError{err: fmt.Errorf("isolated %s render exceeded wall-clock limit", mode)}
		}
		return fmt.Errorf("isolated %s render interrupted: %w", mode, childCtx.Err())
	}

	// The direct child has been reaped. Killing its group makes descendants close
	// the pipes; give the readers a short bounded chance to drain diagnostics.
	select {
	case <-readerDone:
	case <-time.After(300 * time.Millisecond):
		closePipe(stdoutRead)
		closePipe(stderrRead)
		select {
		case <-readerDone:
		case <-time.After(100 * time.Millisecond):
		}
	}
	closePipe(stdoutRead)
	closePipe(stderrRead)
	if waitErr != nil {
		message := strings.TrimSpace(output.String())
		if len(message) > 160 {
			message = message[:160]
		}
		if strings.Contains(message, "renderer sandbox setup failed") {
			return isolatedSandboxError{err: fmt.Errorf("isolated %s render sandbox setup failed: %s", mode, message)}
		}
		// A rejection made from the file's container alone never ran a parser, so there is no renderer state to recycle.
		if office.IsPrecheckFailure(message) {
			return fmt.Errorf("isolated %s render failed: %s", mode, message)
		}
		if message == "" {
			return isolatedChildCompromiseError{err: fmt.Errorf("isolated %s render failed: %w", mode, waitErr)}
		}
		return isolatedChildCompromiseError{err: fmt.Errorf("isolated %s render failed: %s", mode, message)}
	}
	return nil
}

func classifyIsolatedFailure(err error) string {
	message := err.Error()
	if code, ok := office.CodeFromMessage(message); ok {
		return code
	}
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
