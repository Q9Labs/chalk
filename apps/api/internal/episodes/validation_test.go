package episodes

import (
	"errors"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func admissionInputForTest(t *testing.T) AdmitParticipantInput {
	t.Helper()
	id := func() utilities.ID {
		value, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	return AdmitParticipantInput{
		TenantID:      id(),
		SpaceID:       id(),
		EpisodeID:     id(),
		ParticipantID: id(),
		Name:          "Participant",
		Role:          "collaborator",
		Request:       Request{Key: "0123456789abcdef"},
	}
}

func TestPrepareAdmissionInputIdentityKind(t *testing.T) {
	t.Run("defaults to user", func(t *testing.T) {
		input := admissionInputForTest(t)
		if err := prepareAdmissionInput(&input); err != nil {
			t.Fatalf("prepare admission: %v", err)
		}
		if input.IdentityKind != IdentityKindUser {
			t.Fatalf("identity kind = %q, want user", input.IdentityKind)
		}
	})

	t.Run("accepts an agent with an external identity", func(t *testing.T) {
		input := admissionInputForTest(t)
		input.IdentityExternalID = "external-agent"
		input.IdentityKind = IdentityKindAgent
		if err := prepareAdmissionInput(&input); err != nil {
			t.Fatalf("prepare agent admission: %v", err)
		}
	})

	t.Run("rejects an unknown kind", func(t *testing.T) {
		input := admissionInputForTest(t)
		input.IdentityExternalID = "external-participant"
		input.IdentityKind = "service"
		if err := prepareAdmissionInput(&input); !errors.Is(err, ErrInvalidIdentityMode) {
			t.Fatalf("prepare unknown kind = %v, want invalid identity mode", err)
		}
	})

	t.Run("rejects an agent without an external identity", func(t *testing.T) {
		input := admissionInputForTest(t)
		input.IdentityKind = IdentityKindAgent
		if err := prepareAdmissionInput(&input); !errors.Is(err, ErrInvalidIdentityMode) {
			t.Fatalf("prepare unregistered agent = %v, want invalid identity mode", err)
		}
	})
}

func TestPrepareAdmissionInputDescription(t *testing.T) {
	t.Run("accepts eighty Unicode characters", func(t *testing.T) {
		input := admissionInputForTest(t)
		input.Description = strings.Repeat("å", 80)
		if err := prepareAdmissionInput(&input); err != nil {
			t.Fatalf("prepare description: %v", err)
		}
	})

	for name, description := range map[string]string{
		"eighty-one characters": strings.Repeat("a", 81),
		"leading space":         " AI teammate",
		"trailing space":        "AI teammate ",
		"line break":            "AI\nteammate",
		"control character":     "AI\tteammate",
	} {
		t.Run("rejects "+name, func(t *testing.T) {
			input := admissionInputForTest(t)
			input.Description = description
			if err := prepareAdmissionInput(&input); !errors.Is(err, ErrInvalidParticipantDescription) {
				t.Fatalf("prepare description = %v, want invalid participant description", err)
			}
		})
	}
}

func TestAdmissionFingerprintIdentityKindCompatibility(t *testing.T) {
	omitted := admissionInputForTest(t)
	explicitUser := omitted
	explicitUser.IdentityKind = IdentityKindUser
	agent := omitted
	agent.IdentityExternalID = "external-agent"
	agent.IdentityKind = IdentityKindAgent

	for name, input := range map[string]*AdmitParticipantInput{"omitted": &omitted, "explicit user": &explicitUser, "agent": &agent} {
		if err := prepareAdmissionInput(input); err != nil {
			t.Fatalf("prepare %s: %v", name, err)
		}
	}
	if omitted.Request.Fingerprint != explicitUser.Request.Fingerprint {
		t.Fatal("explicit user kind must keep the pre-kind user admission fingerprint")
	}
	if agent.Request.Fingerprint == omitted.Request.Fingerprint {
		t.Fatal("agent kind must change the idempotency fingerprint")
	}

	described := omitted
	described.Description = "AI teammate"
	if err := prepareAdmissionInput(&described); err != nil {
		t.Fatalf("prepare described admission: %v", err)
	}
	if described.Request.Fingerprint == omitted.Request.Fingerprint {
		t.Fatal("description must change the idempotency fingerprint")
	}
}
