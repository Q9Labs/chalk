package auditlogs

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestActorTypeAcceptsOperator(t *testing.T) {
	actor, err := actorType(ActorOperator)
	if err != nil {
		t.Fatalf("operator actor type rejected: %v", err)
	}
	if actor != ActorOperator {
		t.Fatalf("actor type = %q, want %q", actor, ActorOperator)
	}
}

func TestPrepareCreateInputRejectsUnknownActorType(t *testing.T) {
	tenantID, err := utilities.ParseID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	if err != nil {
		t.Fatalf("parse tenant id: %v", err)
	}
	input := CreateInput{
		TenantID:  tenantID,
		ActorType: "tenant_role",
		Action:    "episode_diagnostic.read",
		Outcome:   OutcomeSuccess,
	}
	if err := prepareCreateInput(&input); err != ErrInvalidActorType {
		t.Fatalf("prepareCreateInput error = %v, want %v", err, ErrInvalidActorType)
	}
}
