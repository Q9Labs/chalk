package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/q9labs/chalk/apps/document-renderer/internal/render"
	"github.com/q9labs/chalk/apps/document-renderer/internal/worker"
)

type invocationEvent struct {
	Source string `json:"source"`
	JobID  string `json:"jobId"`
}

func main() {
	if os.Getenv("RENDER_PAGE_MODE") == "1" {
		os.Exit(render.RunPageChild(os.Args[1:]))
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	control, err := configureControl(context.Background())
	if err != nil {
		logger.Error("renderer configuration failed", "error", err)
		os.Exit(1)
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

func configureControl(ctx context.Context) (worker.ControlClient, error) {
	secret := os.Getenv("CHALK_PRESENTING_WORKLOAD_AUTH_SECRET")
	if secret == "" {
		parameterARN := os.Getenv("CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN")
		if parameterARN == "" {
			return worker.ControlClient{}, fmt.Errorf("missing presenting workload auth secret or parameter ARN")
		}
		config, err := awsconfig.LoadDefaultConfig(ctx)
		if err != nil {
			return worker.ControlClient{}, err
		}
		withDecryption := true
		output, err := ssm.NewFromConfig(config).GetParameter(ctx, &ssm.GetParameterInput{Name: &parameterARN, WithDecryption: &withDecryption})
		if err != nil {
			return worker.ControlClient{}, fmt.Errorf("read presenting workload auth parameter: %w", err)
		}
		if output.Parameter == nil || output.Parameter.Value == nil {
			return worker.ControlClient{}, fmt.Errorf("presenting workload auth parameter is empty")
		}
		secret = *output.Parameter.Value
	}
	baseURL := os.Getenv("CONTROL_API_BASE_URL")
	audience := envOr("CONTROL_API_AUDIENCE", "chalk-control-api")
	environment := envOr("CHALK_ENVIRONMENT", envOr("ENVIRONMENT", "staging"))
	releaseID := envOr("CHALK_RELEASE_ID", "unknown")
	if baseURL == "" || len(secret) < 32 {
		return worker.ControlClient{}, fmt.Errorf("renderer control configuration is incomplete")
	}
	return worker.NewControlClient(baseURL, secret, environment, releaseID, audience), nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func runLambdaRuntime(endpoint string, control worker.ControlClient, logger *slog.Logger) {
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

func processOne(ctx context.Context, control worker.ControlClient, event invocationEvent) error {
	assignment, err := control.Claim(ctx, event.JobID)
	if err != nil {
		return err
	}
	if assignment == nil {
		return nil
	}
	return worker.Process(ctx, control, *assignment)
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
