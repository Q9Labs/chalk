package lambdawaker

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/lambda/types"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

type invokeClient interface {
	Invoke(context.Context, *lambda.InvokeInput, ...func(*lambda.Options)) (*lambda.InvokeOutput, error)
}

type Waker struct {
	client       invokeClient
	functionName string
	logger       *slog.Logger
}

func New(ctx context.Context, functionName string, logger *slog.Logger) (Waker, error) {
	if functionName == "" {
		return Waker{}, errors.New("missing transcription dispatcher function name")
	}
	config, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return Waker{}, err
	}
	return newWaker(lambda.NewFromConfig(config), functionName, logger), nil
}

func newWaker(client invokeClient, functionName string, logger *slog.Logger) Waker {
	if logger == nil {
		logger = slog.Default()
	}
	return Waker{client: client, functionName: functionName, logger: logger}
}

func (w Waker) Wake(ctx context.Context, input transcripts.DispatcherWakeInput) {
	if w.client == nil || w.functionName == "" {
		w.logger.Error("transcription wake unavailable", "event", "transcription.wake_failed")
		return
	}
	payload, err := json.Marshal(map[string]string{
		"source":      "wake",
		"jobId":       input.JobID.String(),
		"journeyId":   input.JourneyID.String(),
		"traceparent": input.Traceparent,
		"tracestate":  input.Tracestate,
	})
	if err != nil {
		w.logger.Error("transcription wake encoding failed", "event", "transcription.wake_failed")
		return
	}
	wakeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	output, err := w.client.Invoke(wakeCtx, &lambda.InvokeInput{FunctionName: aws.String(w.functionName), InvocationType: types.InvocationTypeEvent, Payload: payload})
	if err != nil || output == nil || output.StatusCode != 202 {
		w.logger.Error("transcription wake failed", "event", "transcription.wake_failed", "error", safeError(err), "status_code", statusCode(output))
		return
	}
	w.logger.Info("transcription wake queued", "event", "transcription.wake_queued", "job_id", input.JobID.String())
}

func safeError(err error) string {
	if err == nil {
		return "unexpected_status"
	}
	return err.Error()
}

func statusCode(output *lambda.InvokeOutput) int32 {
	if output == nil {
		return 0
	}
	return output.StatusCode
}

var _ transcripts.DispatcherWaker = Waker{}
