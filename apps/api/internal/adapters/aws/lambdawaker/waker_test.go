package lambdawaker

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/lambda/types"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type invokeStub struct {
	input *lambda.InvokeInput
}

func (s *invokeStub) Invoke(_ context.Context, input *lambda.InvokeInput, _ ...func(*lambda.Options)) (*lambda.InvokeOutput, error) {
	s.input = input
	return &lambda.InvokeOutput{StatusCode: 202}, nil
}

func TestWakerQueuesAsyncHint(t *testing.T) {
	client := &invokeStub{}
	waker := newWaker(client, "chalk-transcription", slog.New(slog.NewTextHandler(io.Discard, nil)))
	jobID, err := utilities.ParseID("11111111-1111-1111-1111-111111111111")
	if err != nil {
		t.Fatal(err)
	}
	waker.Wake(context.Background(), transcripts.DispatcherWakeInput{JobID: jobID})
	if client.input == nil || client.input.InvocationType != types.InvocationTypeEvent || string(client.input.Payload) == "" {
		t.Fatalf("invoke input = %#v, want asynchronous payload", client.input)
	}
}
