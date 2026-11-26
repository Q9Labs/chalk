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

	controlplane "github.com/q9labs/chalk/apps/document-renderer/internal/control"
	"github.com/q9labs/chalk/apps/document-renderer/internal/worker"
)

type invocationEvent struct {
	Source      string `json:"source"`
	JobID       string `json:"jobId"`
	Capability  string `json:"capability"`
	JourneyID   string `json:"journeyId"`
	Traceparent string `json:"traceparent"`
	Tracestate  string `json:"tracestate"`
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
