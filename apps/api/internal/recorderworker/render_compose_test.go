package recorderworker

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestNodeComposeProducerResultAndFailure(t *testing.T) {
	workspace := t.TempDir()
	request := frameRequestForTest(workspace)
	request.FPS = nativeRenderFPS
	result := ComposeResult{SchemaVersion: composeResultVersion, RecordingID: request.RecordingID, EpisodeID: request.EpisodeID,
		PresentationSHA256: request.PresentationSHA256, DecodedMediaSHA256: request.DecodedMediaSHA256,
		Width: request.Width, Height: request.Height, FPS: request.FPS, FrameCount: 16}
	template, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "result-template.json"), template, 0o600); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(workspace, "compose.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\ncp \"$(dirname \"$0\")/result-template.json\" \"$4\"\n: > \"$6\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	producer := NodeComposeProducer{NodePath: "/bin/sh", ScriptPath: script, FFmpegPath: "/bin/true", Encoder: EncoderLibX264, Threads: 2}
	output := filepath.Join(workspace, "recording.mp4")
	if got, err := producer.Compose(context.Background(), request, output); err != nil || got.FrameCount != result.FrameCount {
		t.Fatalf("compose result = %#v, %v", got, err)
	}
	if err := os.Remove(output); err != nil {
		t.Fatal(err)
	}
	result.FrameCount++
	template, _ = json.Marshal(result)
	if err := os.WriteFile(filepath.Join(workspace, "result-template.json"), template, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := producer.Compose(context.Background(), request, output); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("mismatched result error = %v", err)
	}
	if _, err := os.Lstat(output); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("mismatched result left output behind: %v", err)
	}
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho compose-failed >&2\nexit 9\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := producer.Compose(context.Background(), request, output); err == nil || !strings.Contains(err.Error(), "compose-failed") {
		t.Fatalf("failed compositor error = %v", err)
	}
}

func TestNodeComposeProducerCancellationKillsProcessGroup(t *testing.T) {
	workspace := t.TempDir()
	script := filepath.Join(workspace, "compose.sh")
	childPath := filepath.Join(workspace, "child.pid")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 30 &\necho $! > \"$(dirname \"$0\")/child.pid\"\nwait\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	producer := NodeComposeProducer{NodePath: "/bin/sh", ScriptPath: script, FFmpegPath: "/bin/true", Encoder: EncoderLibX264, Threads: 2}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := producer.Compose(ctx, frameRequestForTest(workspace), filepath.Join(workspace, "recording.mp4"))
	if err == nil || time.Since(started) > 5*time.Second {
		t.Fatalf("canceled compose = %v after %s", err, time.Since(started))
	}
	childBytes, err := os.ReadFile(childPath)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(childBytes)))
	if err != nil {
		t.Fatal(err)
	}
	childExited := false
	t.Cleanup(func() {
		if !childExited {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if !composeTestProcessAlive(pid) {
			childExited = true
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("compositor child survived cancellation")
}

func composeTestProcessAlive(pid int) bool {
	if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
		return false
	}
	if runtime.GOOS == "linux" {
		stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
		return err == nil && !strings.Contains(string(stat), ") Z ")
	}
	return true
}
