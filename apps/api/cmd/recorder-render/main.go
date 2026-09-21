package main

import (
	"context"
	"encoding/json"
	"errors"
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
	runMode := flag.Bool("run", false, "run the server-authorized recording render worker")
	environment := flag.String("environment", os.Getenv("CHALK_RECORDER_ENVIRONMENT"), "recording KMS environment name")
	controlPlaneURL := flag.String("control-plane-url", os.Getenv("CHALK_RECORDER_CONTROL_PLANE_URL"), "private recorder control-plane URL")
	workerCertificate := flag.String("worker-cert", os.Getenv("CHALK_RECORDER_WORKER_CERT"), "worker mTLS certificate")
	workerKey := flag.String("worker-key", os.Getenv("CHALK_RECORDER_WORKER_KEY"), "worker mTLS private key")
	serverCA := flag.String("server-ca", os.Getenv("CHALK_RECORDER_SERVER_CA"), "control-plane server CA")
	serverName := flag.String("server-name", os.Getenv("CHALK_RECORDER_SERVER_NAME"), "control-plane TLS server name")
	workRoot := flag.String("work-root", os.Getenv("CHALK_RECORDING_RENDER_WORK_ROOT"), "absolute parent directory for ephemeral render attempts")
	nodePath := flag.String("node", os.Getenv("CHALK_RECORDING_NODE_PATH"), "absolute Node.js executable path")
	rendererScript := flag.String("renderer-script", os.Getenv("CHALK_RECORDING_RENDERER_SCRIPT"), "absolute recording renderer CLI path")
	uiBuildRegistry := flag.String("ui-build-registry", os.Getenv("CHALK_RECORDING_UI_BUILD_REGISTRY"), "absolute installed recording UI build registry path")
	ffmpegPath := flag.String("ffmpeg", os.Getenv("CHALK_RECORDING_FFMPEG_PATH"), "absolute FFmpeg executable path")
	ffprobePath := flag.String("ffprobe", os.Getenv("CHALK_RECORDING_FFPROBE_PATH"), "absolute FFprobe executable path")
	encoder := flag.String("encoder", os.Getenv("CHALK_RECORDING_VIDEO_ENCODER"), "explicit video encoder: libx264, h264_videotoolbox, or h264_nvenc")
	frameConcurrency := flag.Int("frame-concurrency", 1, "parallel browser pages per recording (1-8)")
	flag.Parse()
	if *fixture == *runMode {
		fmt.Fprintln(os.Stderr, "recorder-render: exactly one of --fixture or --run is required")
		os.Exit(2)
	}
	if *runMode {
		if err := runWorker(renderWorkerConfig{
			Environment: *environment, ControlPlaneURL: *controlPlaneURL, WorkerCertificate: *workerCertificate, WorkerKey: *workerKey,
			ServerCA: *serverCA, ServerName: *serverName, WorkRoot: *workRoot, NodePath: *nodePath, RendererScript: *rendererScript,
			UIBuildRegistry: *uiBuildRegistry, FFmpegPath: *ffmpegPath, FFprobePath: *ffprobePath, Encoder: *encoder, FrameConcurrency: *frameConcurrency,
		}); err != nil {
			if !errors.Is(err, recorderworker.ErrReadinessFailure) && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)) {
				return
			}
			fmt.Fprintln(os.Stderr, "recorder-render:", err)
			os.Exit(1)
		}
		return
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
