package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	controlplane "github.com/q9labs/chalk/apps/document-renderer/internal/control"
	"github.com/q9labs/chalk/apps/document-renderer/internal/render"
	"github.com/q9labs/chalk/apps/document-renderer/internal/worker"
)

var runtimeBootNonce = newRuntimeBootNonce()

func newRuntimeBootNonce() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "unavailable"
	}
	return hex.EncodeToString(buf)
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := worker.MakeProcessNonDumpable(); err != nil {
		logger.Warn("renderer process protection unavailable", "error", err)
	}
	if mode := os.Getenv("RENDER_CHILD_MODE"); mode != "" {
		os.Exit(render.RunChild(mode, os.Args[1:]))
	}
	if os.Getenv("RENDER_PAGE_MODE") == "1" {
		os.Exit(render.RunPageChild(os.Args[1:]))
	}
	if benchmarkFile := os.Getenv("RENDER_BENCHMARK_FILE"); benchmarkFile != "" {
		if err := runBenchmark(benchmarkFile); err != nil {
			logger.Error("benchmark failed", "error", err)
			os.Exit(1)
		}
		return
	}
	control, err := configureControl(context.Background())
	if err != nil {
		logger.Error("renderer configuration failed", "error", err)
		os.Exit(1)
	}
	if address := os.Getenv("RENDERER_LOCAL_ADDR"); address != "" {
		runLocalRenderer(address, control, logger)
		return
	}
	if endpoint := os.Getenv("AWS_LAMBDA_RUNTIME_API"); endpoint != "" {
		runLambdaRuntime(endpoint, control, logger)
		return
	}
	// Local proof mode: one claim loop pass, useful for arm64 Linux benchmarks without a Lambda emulation layer.
	if err := processOne(context.Background(), control, invocationEvent{JobID: os.Getenv("RENDER_JOB_ID")}); err != nil {
		logger.Error("render failed", "error", err)
		os.Exit(1)
	}
}

func configureControl(context.Context) (controlplane.ControlClient, error) {
	baseURL := os.Getenv("CONTROL_API_BASE_URL")
	if baseURL == "" {
		return controlplane.ControlClient{}, fmt.Errorf("missing presenting control API base URL")
	}
	return controlplane.NewControlClient(baseURL), nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func runLocalRenderer(address string, control controlplane.ControlClient, logger *slog.Logger) {
	server := &http.Server{Addr: address, ReadHeaderTimeout: 5 * time.Second}
	http.DefaultServeMux.Handle("/invoke", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var event invocationEvent
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&event); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
			defer cancel()
			if err := processOne(ctx, control, event); err != nil {
				logger.Error("local render invocation failed; exiting to recycle renderer state", "error", err)
				os.Exit(1)
			}
		}()
		w.WriteHeader(http.StatusAccepted)
	}))
	logger.Info("local presenting renderer listening", "address", address)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("local presenting renderer stopped", "error", err)
		os.Exit(1)
	}
}

func runBenchmark(path string) error {
	started := time.Now()
	source, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	mode := envOr("RENDER_BENCHMARK_MODE", "page")
	if mode == "page" {
		bitmap, width, height, _, err := render.RenderPDFPage(source, 1, 1600)
		if err != nil {
			return err
		}
		thumbnail, thumbWidth, thumbHeight, err := render.ResizeBGRA(bitmap, width, height, 240)
		if err != nil {
			return err
		}
		if _, err := render.EncodeWebP(bitmap, width, height, 78); err != nil {
			return err
		}
		if _, err := render.EncodeWebP(thumbnail, thumbWidth, thumbHeight, 78); err != nil {
			return err
		}
		fmt.Printf(`{"mode":"page","durationMs":%d,"width":%d,"height":%d}`+"\n", time.Since(started).Milliseconds(), width, height)
		return nil
	}
	inventory, _, err := render.PDFInventoryFromBytes(source)
	if err != nil {
		return err
	}
	input, err := os.CreateTemp("", "benchmark-source-*")
	if err != nil {
		return err
	}
	inputPath := input.Name()
	_ = input.Close()
	if err := os.WriteFile(inputPath, source, 0o600); err != nil {
		return err
	}
	defer os.Remove(inputPath)
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	semaphore := make(chan struct{}, 2)
	errorsChannel := make(chan error, inventory.PageCount)
	var wait sync.WaitGroup
	for page := 1; page <= inventory.PageCount; page++ {
		page := page
		wait.Add(1)
		go func() {
			defer wait.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			prefix := fmt.Sprintf("%s-%d", inputPath, page)
			command := exec.Command(executable, inputPath, prefix, fmt.Sprint(page), "1600")
			command.Env = append(os.Environ(), "RENDER_PAGE_MODE=1")
			if output, err := command.CombinedOutput(); err != nil {
				errorsChannel <- fmt.Errorf("page %d: %w: %s", page, err, output)
				return
			}
			bitmap, err := os.ReadFile(prefix + ".raw")
			if err != nil {
				errorsChannel <- err
				return
			}
			var metadata struct{ Width, Height int }
			metadataBytes, err := os.ReadFile(prefix + ".json")
			if err == nil {
				err = json.Unmarshal(metadataBytes, &metadata)
			}
			if err != nil {
				errorsChannel <- err
				return
			}
			if len(bitmap) != metadata.Width*metadata.Height*4 {
				errorsChannel <- fmt.Errorf("page %d bitmap length mismatch", page)
				return
			}
			if _, err := render.EncodeWebP(bitmap, metadata.Width, metadata.Height, 78); err != nil {
				errorsChannel <- err
				return
			}
			thumbnail, width, height, err := render.ResizeBGRA(bitmap, metadata.Width, metadata.Height, 240)
			if err != nil {
				errorsChannel <- err
				return
			}
			if _, err := render.EncodeWebP(thumbnail, width, height, 78); err != nil {
				errorsChannel <- err
			}
			_ = os.Remove(prefix + ".raw")
			_ = os.Remove(prefix + ".json")
		}()
	}
	wait.Wait()
	close(errorsChannel)
	for err := range errorsChannel {
		if err != nil {
			return err
		}
	}
	fmt.Printf(`{"mode":"full","pages":%d,"durationMs":%d}`+"\n", inventory.PageCount, time.Since(started).Milliseconds())
	return nil
}
