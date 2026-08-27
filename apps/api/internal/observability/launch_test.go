package observability

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
)

func TestInstrumentParticipantMediaVerifierExposesRecoveryVerification(t *testing.T) {
	next := recoveryVerifierStub{}
	verifier := InstrumentParticipantMediaVerifier(&next, nil)
	if _, err := verifier.Verify(context.Background(), "strict"); err != nil {
		t.Fatal(err)
	}
	if _, err := verifier.VerifyForRecovery(context.Background(), "recovery"); err != nil {
		t.Fatal(err)
	}
	if next.strictCalls != 1 || next.recoveryCalls != 1 {
		t.Fatalf("strict calls = %d, recovery calls = %d", next.strictCalls, next.recoveryCalls)
	}
}

type recoveryVerifierStub struct {
	strictCalls   int
	recoveryCalls int
}

func (s *recoveryVerifierStub) Verify(context.Context, string) (accessgrants.Subject, error) {
	s.strictCalls++
	return accessgrants.Subject{}, nil
}

func (s *recoveryVerifierStub) VerifyForRecovery(context.Context, string) (accessgrants.Subject, error) {
	s.recoveryCalls++
	return accessgrants.Subject{}, nil
}
