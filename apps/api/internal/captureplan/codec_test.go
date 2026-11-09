package captureplan

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestDecodePlanReconstructsAndChecksFingerprint(t *testing.T) {
	plan := testCodecPlan(t)
	decoded, err := DecodePlan(plan.CanonicalJSON(), plan.FingerprintHex())
	if err != nil {
		t.Fatalf("decode plan: %v", err)
	}
	if decoded.FingerprintHex() != plan.FingerprintHex() || decoded.Revision() != plan.Revision() {
		t.Fatalf("decoded fingerprint or revision changed: %s / %d", decoded.FingerprintHex(), decoded.Revision())
	}

	if _, err := DecodePlan(plan.CanonicalJSON(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); !errors.Is(err, ErrPlanFingerprintMatch) {
		t.Fatalf("fingerprint mismatch error = %v", err)
	}
}

func TestDecodePlanRejectsUnknownTrailingAndOversizedJSON(t *testing.T) {
	plan := testCodecPlan(t)
	var value map[string]any
	if err := json.Unmarshal(plan.CanonicalJSON(), &value); err != nil {
		t.Fatalf("unmarshal canonical plan: %v", err)
	}
	value["unexpected"] = true
	unknown, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal unknown plan: %v", err)
	}
	if _, err := DecodePlan(unknown, plan.FingerprintHex()); err == nil {
		t.Fatal("unknown plan field accepted")
	}
	if _, err := DecodePlan(append(plan.CanonicalJSON(), []byte(" {}")...), plan.FingerprintHex()); err == nil {
		t.Fatal("trailing JSON accepted")
	}
	if _, err := DecodePlan(make([]byte, MaximumEncodedPlanBytes+1), plan.FingerprintHex()); !errors.Is(err, ErrPlanPayloadTooLarge) {
		t.Fatalf("oversized plan error = %v", err)
	}
}

func testCodecPlan(t *testing.T) Plan {
	t.Helper()
	parse := func(value string) utilities.ID {
		id, err := utilities.ParseID(value)
		if err != nil {
			t.Fatalf("parse test id: %v", err)
		}
		return id
	}
	plan, err := NewPlan(PlanInput{
		Authority: PlanAuthority{
			PlanHandle: "11111111-1111-4111-8111-111111111111",
			TenantID:   parse("22222222-2222-4222-8222-222222222222"), SpaceID: parse("33333333-3333-4333-8333-333333333333"),
			EpisodeID: parse("44444444-4444-4444-8444-444444444444"), RecordingID: parse("55555555-5555-4555-8555-555555555555"),
			JobID: parse("66666666-6666-4666-8666-666666666666"), AttemptCount: 1, FencingGeneration: 1,
			CaptureEpoch: 1, EnvelopeDigest: bytesOf(0x42),
		},
		Revision: 1, LayoutProfile: LayoutProfileComposite720PV1, ParticipantLimit: 10,
		InputBitrateBPS: 4_000_000, EffectiveDeadline: time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC),
		StopState: StopStateRunning,
	})
	if err != nil {
		t.Fatalf("new test plan: %v", err)
	}
	return plan
}

func bytesOf(value byte) []byte {
	result := make([]byte, 32)
	result[0] = value
	return result
}
