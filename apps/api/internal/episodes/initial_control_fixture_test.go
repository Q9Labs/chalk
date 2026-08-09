package episodes_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
)

type apiEpisodeSnapshotFixture struct {
	ConfigSnapshot     json.RawMessage `json:"config_snapshot"`
	DeadlineAt         string          `json:"deadline_at"`
	DeadlineGeneration int64           `json:"deadline_generation"`
	FoldedState        json.RawMessage `json:"folded_state"`
	StateDigest        string          `json:"state_digest"`
	SnapshotBytes      int64           `json:"snapshot_bytes"`
}

func TestInitialControlStateMatchesSyncFixture(t *testing.T) {
	fixture := readAPIEpisodeSnapshotFixture(t)
	deadline, err := time.Parse(time.RFC3339Nano, fixture.DeadlineAt)
	if err != nil {
		t.Fatal(err)
	}

	state, err := episodes.NewInitialControlState(episodes.InitialControlPolicy{
		ConfigSnapshot:     fixture.ConfigSnapshot,
		DeadlineAt:         deadline,
		DeadlineGeneration: fixture.DeadlineGeneration,
	})
	if err != nil {
		t.Fatal(err)
	}
	var gotFolded, wantFolded map[string]any
	if err := json.Unmarshal(state.FoldedState, &gotFolded); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(fixture.FoldedState, &wantFolded); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotFolded, wantFolded) {
		t.Fatalf("folded state = %s, want %s", state.FoldedState, fixture.FoldedState)
	}
	wantDigest, err := hex.DecodeString(fixture.StateDigest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(state.Digest[:], wantDigest) {
		t.Fatalf("digest = %x, want %x", state.Digest, wantDigest)
	}
	if state.SnapshotBytes != fixture.SnapshotBytes {
		t.Fatalf("snapshot bytes = %d, want %d", state.SnapshotBytes, fixture.SnapshotBytes)
	}

	// Keep the fixture's digest contract explicit in this language boundary.
	if len(state.Digest) != sha256.Size {
		t.Fatalf("digest length = %d, want %d", len(state.Digest), sha256.Size)
	}
}

func readAPIEpisodeSnapshotFixture(t *testing.T) apiEpisodeSnapshotFixture {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	path := filepath.Join(filepath.Dir(source), "../../../../apps/sync/test/fixtures/api_episode_snapshot_v1.json")
	encoded, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture apiEpisodeSnapshotFixture
	if err := json.Unmarshal(encoded, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}
