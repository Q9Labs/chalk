package traceharness

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestPublicInviteAccessRecoveryScenario(t *testing.T) {
	result, err := Run(context.Background(), RoutePublicInviteAccessRecoveryScenario)
	if err != nil {
		t.Fatal(err)
	}
	if result.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", result.StatusCode)
	}
	if len(result.Events) == 0 {
		t.Fatal("scenario returned no events")
	}
	for _, event := range result.Events {
		encodedBytes, marshalErr := json.Marshal(event)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		encoded := string(encodedBytes)
		if strings.Contains(encoded, "eyJ") || strings.Contains(encoded, "trace-connection") {
			t.Fatalf("event leaked credential material: %#v", event)
		}
	}
	if !strings.Contains(string(result.Body), `"diagnostics":"issued"`) {
		t.Fatalf("body = %s, want diagnostics proof", result.Body)
	}
}
