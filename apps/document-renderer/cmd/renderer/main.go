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
	"strings"
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

type invocationEvent struct {
	Source      string `json:"source"`
	JobID       string `json:"jobId"`
	Capability  string `json:"capability"`
	JourneyID   string `json:"journeyId"`
	Traceparent string `json:"traceparent"`
	Tracestate  string `json:"tracestate"`
}

func rendererRunsOnLambda() bool {
	return os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" || os.Getenv("RENDERER_LAMBDA") == "1"
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	lambdaRuntime := rendererRunsOnLambda()
	if err := worker.MakeProcessNonDumpable(); err != nil {
		if !lambdaRuntime {
			logger.Error("renderer process protection unavailable", "error", err)
			os.Exit(1)
		}
		// Lambda's seccomp policy blocks prctl even though the runtime starts as an
		// ordinary dumpable process. Its compensating boundary is mandatory
		// execution-environment recycling after every invocation.
		logger.Error("renderer process protection unavailable; relying on execution-environment recycling", "error", err)
	}
	if mode := os.Getenv("RENDER_CHILD_MODE"); mode != "" {
		os.Exit(render.RunChild(mode, os.Args[1:]))
	}
	if os.Getenv("RENDER_PAGE_MODE") == "1" {
		os.Exit(render.RunPageChild(os.Args[1:]))
	}
	resetScratch := worker.ResetRendererScratch
	if lambdaRuntime {
		resetScratch = worker.ResetWritableTemp
	}
	if err := resetScratch(); err != nil {
		logger.Error("renderer scratch reset failed", "error", err)
		os.Exit(1)
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

func runLambdaRuntime(endpoint string, control controlplane.ControlClient, logger *slog.Logger) {
	client := &http.Client{Timeout: 0}
	base := "http://" + endpoint + "/2018-06-01/runtime"
	for {
		request, err := http.NewRequest(http.MethodGet, base+"/invocation/next", nil)
		if err != nil {
			logger.Error("runtime request construction failed", "error", err)
			return
		}
		response, err := client.Do(request)
		if err != nil {
			logger.Error("runtime invocation poll failed", "error", err)
			<-time.After(time.Second)
			continue
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		requestID := response.Header.Get("Lambda-Runtime-Aws-Request-Id")
		response.Body.Close()
		if err != nil || response.StatusCode != http.StatusOK {
			logger.Error("runtime invocation poll returned an error", "status", response.StatusCode, "error", err)
			continue
		}
		var event invocationEvent
		if err := json.Unmarshal(body, &event); err != nil {
			postRuntimeResult(client, base+"/invocation/"+requestID+"/error", []byte(`{"errorMessage":"invalid invocation event"}`), logger)
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
		logger.Info("render invocation claimed", "job_id", event.JobID, "boot_nonce", runtimeBootNonce)
		processErr := processOne(ctx, control, event)
		cancel()
		if processErr == nil {
			postRuntimeResult(client, base+"/invocation/"+requestID+"/response", []byte(`{"ok":true}`), logger)
			logger.Info("render invocation finished; recycling execution environment", "boot_nonce", runtimeBootNonce)
			os.Exit(0)
		}
		payload, _ := json.Marshal(map[string]string{"errorMessage": processErr.Error()})
		postRuntimeResult(client, base+"/invocation/"+requestID+"/error", payload, logger)
		logger.Error("render invocation failed; recycling execution environment", "error", processErr, "boot_nonce", runtimeBootNonce)
		os.Exit(1)
	}
}

func processOne(ctx context.Context, control controlplane.ControlClient, event invocationEvent) error {
	if event.Capability == "" {
		return fmt.Errorf("render invocation is missing its job capability")
	}
	control = control.WithCapability(event.Capability).WithJourney(event.JourneyID, event.Traceparent, event.Tracestate)
	assignment, err := control.Claim(ctx, event.JobID)
	if err != nil {
		return err
	}
	if assignment == nil {
		return nil
	}
	if err := worker.Process(ctx, control, *assignment); err != nil {
		return fmt.Errorf("render job %s: %w", assignment.JobID, err)
	}
	return nil
}

func postRuntimeResult(client *http.Client, url string, body []byte, logger *slog.Logger) {
	request, err := http.NewRequest(http.MethodPost, url, strings.NewReader(string(body)))
	if err != nil {
		logger.Error("runtime result request construction failed", "error", err)
		return
	}
	request.Header.Set("content-type", "application/json")
	response, err := client.Do(request)
	if err == nil {
		response.Body.Close()
	}
	if err != nil {
		logger.Error("runtime result post failed", "error", err)
	}
}
