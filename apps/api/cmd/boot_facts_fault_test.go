package main

// Chain hop for flags.unrecorded_change and the boot witnesses of the release
// checks: two real boots of the kernel — configure, SetFlags, release.started —
// land their rows in each symptom's chain dir, one boot changing its flags
// where no marker explains it and one repeating the same map. Stamps are
// pinned so the chain replays byte-identically. Run it:
//
//	go -C apps/api test ./cmd -run TestBootFactsChain -count=1

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/obs"
)

var bootChainDirs = map[string]string{
	"flags": filepath.Join("..", "..", "..", "observability", "fixtures", "flags.unrecorded_change", "chain"),
	"surge": filepath.Join("..", "..", "..", "observability", "fixtures", "release.failures_after_change", "chain"),
}

const bootChainBase = 1795176000000 // 2026-11-20T12:00:00Z, one boot a minute

type bootCapture struct {
	mu   sync.Mutex
	rows []map[string]any
}

func (c *bootCapture) Enabled(context.Context, slog.Level) bool { return true }
func (c *bootCapture) WithAttrs([]slog.Attr) slog.Handler       { return c }
func (c *bootCapture) WithGroup(string) slog.Handler            { return c }

func (c *bootCapture) Handle(_ context.Context, record slog.Record) error {
	row := map[string]any{}
	record.Attrs(func(attr slog.Attr) bool {
		row[attr.Key] = attr.Value.Any()
		return true
	})
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rows = append(c.rows, row)
	return nil
}

func (c *bootCapture) pinned() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []map[string]any
	for _, row := range c.rows {
		row["event_id"] = fmt.Sprintf("chain-boot-%04d", len(out)+1)
		row["est_server_ms"] = bootChainBase + int64(len(out))*60_000
		out = append(out, row)
	}
	return out
}

// bootOnce runs one real boot of the kernel: configure, the flags snapshot and
// the release.started fact, with a boot's own source_id.
func bootOnce(capture *bootCapture, sourceID, releaseID, bootID string, flags obs.Flags) {
	obs.Configure(obs.Config{Logger: slog.New(capture), Mode: obs.ModeClosed, Module: "api", Env: "test", SourceID: sourceID})
	obs.SetFlags(context.Background(), flags)
	obs.Fact(context.Background(), obs.EventReleaseStarted,
		slog.String("release_id", releaseID),
		slog.String("host_boot_id", bootID),
		slog.String("previous_boot_end", previousBootEnd("")))
}

func compareBootChain(t *testing.T, dir, name string, value any) {
	t.Helper()
	text, _ := json.MarshalIndent(value, "", "  ")
	text = append(text, '\n')
	path := filepath.Join(dir, name)
	if os.Getenv("CHALK_CHAIN_WRITE") == "1" {
		if err := os.WriteFile(path, text, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("chain file %s is not written yet; run the hop with CHALK_CHAIN_WRITE=1", path)
	}
	var want, got any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(text, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s is stale: the boots wrote\n%s", path, text)
	}
}

func TestBootFactsChain(t *testing.T) {
	t.Cleanup(func() { obs.Configure(obs.Config{}) })
	flags := obs.Flags{"sfu_new_episodes": true, "request_logs": "all", "recording": true}

	t.Run("flags", func(t *testing.T) {
		// Two boots, the second on a different flags_hash no marker covers.
		fault := &bootCapture{}
		bootOnce(fault, "src-boot-a", "2026.11.20-0000000", "boot-a", flags)
		changed := obs.Flags{"sfu_new_episodes": false, "request_logs": "all", "recording": true}
		bootOnce(fault, "src-boot-b", "2026.11.20-0000000", "boot-b", changed)
		compareBootChain(t, bootChainDirs["flags"], "boots.fault.json", fault.pinned())

		quiet := &bootCapture{}
		bootOnce(quiet, "src-boot-a", "2026.11.20-0000000", "boot-a", flags)
		bootOnce(quiet, "src-boot-b", "2026.11.20-0000000", "boot-b", changed)
		compareBootChain(t, bootChainDirs["flags"], "boots.healthy.json", quiet.pinned())
	})

	t.Run("surge", func(t *testing.T) {
		// One boot of the marker's release for the deploy_restart window.
		capture := &bootCapture{}
		bootOnce(capture, "src-boot-c", "2026.11.20-aaaaaaa", "boot-c", flags)
		compareBootChain(t, bootChainDirs["surge"], "boots.restart.json", capture.pinned())

		fault := &bootCapture{}
		bootOnce(fault, "src-boot-d", "2026.11.20-eeeeeee", "boot-d", flags)
		compareBootChain(t, bootChainDirs["surge"], "boots.fault.json", fault.pinned())

		quiet := &bootCapture{}
		bootOnce(quiet, "src-boot-e", "2026.11.20-0000000", "boot-e", flags)
		compareBootChain(t, bootChainDirs["surge"], "boots.healthy.json", quiet.pinned())
	})
}
