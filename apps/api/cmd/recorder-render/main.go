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
	dir := flag.String("dir", "", "directory containing capture-bundle.json")
	fixture := flag.Bool("fixture", false, "render a deterministic local fixture")
	flag.Parse()
	if !*fixture {
		fmt.Fprintln(os.Stderr, "recorder-render: only --fixture is available; GPU render provider is intentionally unimplemented")
		os.Exit(2)
	}
	if *dir == "" {
		fmt.Fprintln(os.Stderr, "recorder-render: --dir is required")
		os.Exit(2)
	}
	if err := run(*dir); err != nil {
		fmt.Fprintln(os.Stderr, "recorder-render:", err)
		os.Exit(1)
	}
}

type captureFixture struct {
	Bundle   recorderworker.BundleManifest  `json:"bundle"`
	Envelope recorderworker.EncryptedBundle `json:"envelope"`
}

func run(dir string) error {
	data, err := os.ReadFile(filepath.Join(dir, "capture-bundle.json"))
	if err != nil {
		return err
	}
	var fixture captureFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		return err
	}
	if fixture.Bundle.Version != "capture-bundle.v1" || fixture.Envelope.Algorithm != "AES-256-GCM" {
		return fmt.Errorf("capture fixture is not an encrypted versioned bundle")
	}
	wrappedData, err := os.ReadFile(filepath.Join(dir, "capture-key.wrap.json"))
	if err != nil {
		return err
	}
	var wrappedKey recorderworker.EncryptedBundle
	if err := json.Unmarshal(wrappedData, &wrappedKey); err != nil {
		return err
	}
	key, err := recorderworker.UnwrapFixtureKey(wrappedKey)
	if err != nil {
		return fmt.Errorf("unwrap fixture key: %w", err)
	}
	defer clear(key)
	plaintext, metadata, err := recorderworker.DecryptBundle(key, fixture.Envelope)
	if err != nil {
		return fmt.Errorf("decrypt capture bundle: %w", err)
	}
	defer clear(plaintext)
	if metadata.Checksum != fixture.Bundle.Checksum || metadata.Bytes != fixture.Bundle.Bytes {
		return fmt.Errorf("decrypted metadata does not match capture manifest")
	}
	runner := recorderworker.ExecCommandRunner{}
	sourceFile, err := os.CreateTemp(dir, "decrypted-source-*.ts")
	if err != nil {
		return err
	}
	source := sourceFile.Name()
	defer os.Remove(source)
	if _, err := sourceFile.Write(plaintext); err != nil {
		_ = sourceFile.Close()
		return err
	}
	if err := sourceFile.Close(); err != nil {
		return err
	}
	output := filepath.Join(dir, "recording.mp4")
	plan, err := recorderworker.BuildFFmpegPlan(source, output)
	if err != nil {
		return err
	}
	if _, err := runner.Run(context.Background(), plan.Command[0], plan.Command[1:]...); err != nil {
		return fmt.Errorf("render ffmpeg plan: %w", err)
	}
	if _, err := recorderworker.VerifyMediaWithExpectedDuration(context.Background(), runner, output, 10*time.Second); err != nil {
		return err
	}
	planData, err := json.MarshalIndent(plan, "", "  ")
	if err != nil {
		return err
	}
	planData = append(planData, '\n')
	return os.WriteFile(filepath.Join(dir, "render-plan.json"), planData, 0o600)
}
