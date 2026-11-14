package providerbridge

import (
	"context"
	"encoding/base64"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

func TestLeaveCleanupPreservesRejoinedGeneration(t *testing.T) {
	participantID := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
	publicationID := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"c":"rejoined-connection","m":"0","t":"camera","g":2}`))
	registry := &executorPublicationRegistry{publication: provideroperations.Publication{ParticipantID: participantID, Source: "camera", Enabled: true, PublicationID: publicationID}}
	closer := &executorTrackCloser{}
	executor := NewSFUExecutor(registry, closer)
	operation := provideroperations.OperationInput{ParticipantID: participantID, ParticipantGeneration: 1, Effect: provideroperations.EffectRemoveParticipant}
	if result := executor.Dispatch(context.Background(), operation); result.Outcome != provideroperations.OutcomeSatisfied {
		t.Fatalf("old cleanup outcome = %+v", result)
	}
	if closer.calls != 0 || registry.publication.PublicationID != publicationID || !registry.publication.Enabled {
		t.Fatalf("old cleanup changed rejoined publication: calls=%d publication=%+v", closer.calls, registry.publication)
	}
}
