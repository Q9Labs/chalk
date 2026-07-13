package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderworker"
)

func main() {
	dir := flag.String("dir", "", "directory for a deterministic local fixture")
	fixture := flag.Bool("fixture", false, "write a synthetic capture fixture")
	flag.Parse()
	if !*fixture {
		fmt.Fprintln(os.Stderr, "recorder-capture: only --fixture is available; provider capture is intentionally unimplemented")
		os.Exit(2)
	}
	if *dir == "" {
		fmt.Fprintln(os.Stderr, "recorder-capture: --dir is required")
		os.Exit(2)
	}
	if err := run(*dir); err != nil {
		fmt.Fprintln(os.Stderr, "recorder-capture:", err)
		os.Exit(1)
	}
}

func run(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	now := time.Now().UTC()
	runner := recorderworker.ExecCommandRunner{}
	source := filepath.Join(dir, "capture-source.ts")
	if _, err := runner.Run(context.Background(), "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-f", "lavfi", "-i", "anoisesrc=color=white:sample_rate=48000:amplitude=0.2:seed=1", "-t", "10", "-c:v", "libx264", "-c:a", "aac", "-b:a", "128k", "-f", "mpegts", source); err != nil {
		return fmt.Errorf("create deterministic codec-native input: %w", err)
	}
	plaintext, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	defer os.Remove(source)
	objectKey, err := recorderworker.NewTemporaryObjectKey("tenant-local-1", "recording-local-1", 0)
	if err != nil {
		return err
	}
	bundle, err := recorderworker.NewBundleManifest("recording-local-1", "tenant-local-1", 0, 1, 1, 0, 10_000, "h264+aac", "stage", objectKey, int64(len(plaintext)), recorderworker.Checksum(plaintext))
	if err != nil {
		return err
	}
	provider := &recorderworker.MemoryKeyProvider{}
	envelope, err := recorderworker.EncryptBundle(context.Background(), provider, bundle.RecordingID, bundle, plaintext)
	if err != nil {
		return err
	}
	key, err := provider.RecordingKey(context.Background(), bundle.RecordingID)
	if err != nil {
		return err
	}
	wrappedKey, err := recorderworker.WrapFixtureKey(key)
	clear(key)
	provider.Clear(bundle.RecordingID)
	if err != nil {
		return err
	}
	job := recorderworker.Job{ProtocolVersion: recorderworker.ProtocolVersion, JobID: "job-local-1", TenantID: bundle.TenantID, SessionID: "session-local-1", Attempt: 1, FencingGeneration: 1, Role: recorderworker.RoleCapture, ArtifactClass: "capture_bundle", Authorization: recorderworker.JobAuthorization{IssuedAt: now, Scope: "fixture", ExpiresAt: now.Add(30 * time.Minute)}, ObjectIntents: []recorderworker.ObjectIntent{{Key: bundle.ObjectKey, URL: "https://objects.invalid/" + bundle.ObjectKey, Method: "PUT", Conditional: "if-none-match:*", MaxBytes: int64(len(plaintext)), ExpiresAt: now.Add(30 * time.Minute), OwnerReference: bundle.RecordingID}}}
	if err := job.Validate(now); err != nil {
		return err
	}
	manifest := map[string]any{"created_at": now, "job": job, "bundle": bundle, "envelope": envelope}
	manifest["source_checksum"] = bundle.Checksum
	manifest["fixture_only"] = true
	if err := writeJSON(filepath.Join(dir, "capture-bundle.json"), manifest); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(dir, "capture-key.wrap.json"), wrappedKey); err != nil {
		return err
	}
	clear(plaintext)
	return nil
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o600)
}
