package lambdawaker

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type captureInvokeClient struct {
	payload []byte
}

func (client *captureInvokeClient) Invoke(_ context.Context, input *lambda.InvokeInput, _ ...func(*lambda.Options)) (*lambda.InvokeOutput, error) {
	client.payload = append([]byte(nil), input.Payload...)
	return &lambda.InvokeOutput{StatusCode: 202}, nil
}

func TestWakePropagatesJourneyFromRequestContext(t *testing.T) {
	client := &captureInvokeClient{}
	waker := newWaker(client, "dispatcher", nil)
	jobID, err := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatal(err)
	}
	journeyID, err := utilities.ParseID("22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}

	waker.Wake(observability.ContextWithJourneyID(context.Background(), journeyID), transcripts.DispatcherWakeInput{JobID: jobID})

	var payload map[string]string
	if err := json.Unmarshal(client.payload, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload["journeyId"] != journeyID.String() {
		t.Fatalf("journeyId = %q, want %q", payload["journeyId"], journeyID.String())
	}
}
