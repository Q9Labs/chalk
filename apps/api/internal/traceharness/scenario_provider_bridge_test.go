package traceharness

import (
	"context"
	"testing"
)

func TestAdapterProviderBridgeGrantAuthorizesWithoutProviderMutation(t *testing.T) {
	result, err := Run(context.Background(), AdapterProviderBridgeGrantScenario)
	if err != nil {
		t.Fatal(err)
	}
	if string(result.Body) != `{"effect":"media.grant_publication","outcome":"confirmed"}` {
		t.Fatalf("body = %s", result.Body)
	}
	assertEvent(t, result.Events, "service", "providerbridge.SFUExecutor.Dispatch")
	for _, event := range result.Events {
		if event.Layer == "provider" {
			t.Fatalf("unexpected provider event: %#v", event)
		}
	}
}
