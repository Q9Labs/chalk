package recordingpresentation

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
)

func TestNewAPIBaselineCanFinalizeAfterAPIRollback(t *testing.T) {
	fixture := newParticipantBuilderFixture(t)
	baseline, err := json.Marshal(fixture.source.Profile)
	if err != nil {
		t.Fatal(err)
	}
	var stored Profile
	if err := json.Unmarshal(baseline, &stored); err != nil {
		t.Fatal(err)
	}
	if err := validateRollbackProfile(stored); err != nil {
		t.Fatalf("old API rejected new baseline: %v", err)
	}
	fixture.source.Profile = stored
	setParticipantPlan(t, &fixture.source, 1, []captureplan.ParticipantSnapshot{activeParticipant(fixture.first, "Alex", 1)}, nil)
	built, err := buildPresentation(fixture.source)
	if err != nil {
		t.Fatalf("finalize persisted baseline: %v", err)
	}
	if err := validateRollbackProfile(built.Timeline.Initial.Profile); err != nil {
		t.Fatalf("old API rejected finalized profile: %v", err)
	}
	stored.UIBuildSHA256 = ""
	if err := validateRollbackProfile(stored); err == nil {
		t.Fatal("old API fixture accepted a digest-free baseline")
	}
}

func TestNewAPIPresentationCanBeClaimedAndRetriedAfterNativeWorkerRollback(t *testing.T) {
	fixture := newParticipantBuilderFixture(t)
	setParticipantPlan(t, &fixture.source, 1, []captureplan.ParticipantSnapshot{activeParticipant(fixture.first, "Alex", 1)}, nil)
	built, err := buildPresentation(fixture.source)
	if err != nil {
		t.Fatal(err)
	}
	presentation, err := Encode(built.Timeline)
	if err != nil {
		t.Fatal(err)
	}
	// Old native workers decode and validate the same stored presentation on every retry.
	for _, attempt := range []string{"claim", "retry"} {
		timeline, err := Decode(presentation)
		if err != nil {
			t.Fatalf("%s: decode presentation: %v", attempt, err)
		}
		if err := validateRollbackProfile(timeline.Initial.Profile); err != nil {
			t.Fatalf("%s: old native worker rejected profile: %v", attempt, err)
		}
	}
	built.Timeline.Initial.Profile.UIBuildSHA256 = ""
	if err := validateRollbackProfile(built.Timeline.Initial.Profile); err == nil {
		t.Fatal("old worker fixture accepted a digest-free presentation")
	}
}

// Frozen Profile.validate from 1952389b, used by both the old API and old native
// worker. Keep its required-digest predicate unchanged during this compatibility release.
func validateRollbackProfile(profile Profile) error {
	if !boundedString(profile.Name, 128) || !boundedString(profile.Version, 128) ||
		!sha256Pattern.MatchString(profile.UIBuildSHA256) || !boundedString(profile.Locale, 64) ||
		!boundedString(profile.TimeZone, 128) || profile.FontAssetIDs == nil || len(profile.FontAssetIDs) > 32 ||
		profile.Viewport.Width < 320 || profile.Viewport.Height < 240 ||
		math.IsNaN(profile.Viewport.DeviceScaleFactor) || math.IsInf(profile.Viewport.DeviceScaleFactor, 0) ||
		profile.Viewport.DeviceScaleFactor < 1 || profile.Viewport.DeviceScaleFactor > 4 {
		return invalid("invalid recording presentation profile")
	}
	fontIDs := make(map[string]struct{}, len(profile.FontAssetIDs))
	for _, assetID := range profile.FontAssetIDs {
		if !boundedString(assetID, 512) {
			return invalid("invalid font asset identity")
		}
		if _, exists := fontIDs[assetID]; exists {
			return invalid("duplicate font asset identity")
		}
		fontIDs[assetID] = struct{}{}
	}
	if (profile.Theme.ColorScheme != "light" && profile.Theme.ColorScheme != "dark") ||
		(profile.Theme.Skin != "classic" && profile.Theme.Skin != "chalk") ||
		(profile.Theme.Texture != "none" && profile.Theme.Texture != "paper" && profile.Theme.Texture != "slate") {
		return invalid("invalid presentation theme")
	}
	if _, exists := themePalettes[profile.Theme.Palette]; !exists {
		return invalid("invalid presentation palette")
	}
	return nil
}
