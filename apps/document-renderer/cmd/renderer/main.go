package main

import (
	"context"
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

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	controlplane "github.com/q9labs/chalk/apps/document-renderer/internal/control"
	"github.com/q9labs/chalk/apps/document-renderer/internal/render"
	"github.com/q9labs/chalk/apps/document-renderer/internal/worker"
)

type invocationEvent struct {
	Source      string `json:"source"`
	JobID       string `json:"jobId"`
	JourneyID   string `json:"journeyId"`
	Traceparent string `json:"traceparent"`
	Tracestate  string `json:"tracestate"`
}

func main() {
	if mode := os.Getenv("RENDER_CHILD_MODE"); mode != "" {
		os.Exit(render.RunChild(mode, os.Args[1:]))
	}
	if os.Getenv("RENDER_PAGE_MODE") == "1" {
		os.Exit(render.RunPageChild(os.Args[1:]))
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
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

func configureControl(ctx context.Context) (controlplane.ControlClient, error) {
	secret := os.Getenv("CHALK_PRESENTING_WORKLOAD_AUTH_SECRET")
	if secret == "" {
		parameterARN := os.Getenv("CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN")
		if parameterARN == "" {
			return controlplane.ControlClient{}, fmt.Errorf("missing presenting workload auth secret or parameter ARN")
		}
		config, err := awsconfig.LoadDefaultConfig(ctx)
		if err != nil {
			return controlplane.ControlClient{}, err
		}
		withDecryption := true
		output, err := ssm.NewFromConfig(config).GetParameter(ctx, &ssm.GetParameterInput{Name: &parameterARN, WithDecryption: &withDecryption})
		if err != nil {
			return controlplane.ControlClient{}, fmt.Errorf("read presenting workload auth parameter: %w", err)
		}
		if output.Parameter == nil || output.Parameter.Value == nil {
			return controlplane.ControlClient{}, fmt.Errorf("presenting workload auth parameter is empty")
		}
		secret = *output.Parameter.Value
	}
	baseURL := os.Getenv("CONTROL_API_BASE_URL")
	audience := envOr("CONTROL_API_AUDIENCE", "chalk-control-api")
	environment := envOr("CHALK_ENVIRONMENT", envOr("ENVIRONMENT", "staging"))
	releaseID := envOr("CHALK_RELEASE_ID", "unknown")
	if baseURL == "" || len(secret) < 32 {
		return controlplane.ControlClient{}, fmt.Errorf("renderer control configuration is incomplete")
	}
	return controlplane.NewControlClient(baseURL, secret, environment, releaseID, audience), nil
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
				logger.Error("local render invocation failed", "error", err)
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
			time.Sleep(time.Second)
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
		processErr := processOne(ctx, control, event)
		cancel()
		if processErr == nil {
			postRuntimeResult(client, base+"/invocation/"+requestID+"/response", []byte(`{"ok":true}`), logger)
		} else {
			payload, _ := json.Marshal(map[string]string{"errorMessage": processErr.Error()})
			postRuntimeResult(client, base+"/invocation/"+requestID+"/error", payload, logger)
			logger.Error("render invocation failed", "error", processErr)
		}
	}
}

func processOne(ctx context.Context, control controlplane.ControlClient, event invocationEvent) error {
	assignment, err := control.WithJourney(event.JourneyID, event.Traceparent, event.Tracestate).Claim(ctx, event.JobID)
	if err != nil {
		return err
	}
	if assignment == nil {
		return nil
	}
	if err := worker.Process(ctx, control.WithJourney(event.JourneyID, event.Traceparent, event.Tracestate), *assignment); err != nil {
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
