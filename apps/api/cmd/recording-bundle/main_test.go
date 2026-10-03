package main

import (
	"bytes"
	"encoding/json"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const storedFixture = "../../internal/recordingbundle/testdata/bundle-v1.encrypted.json"

func TestSummarizeStoredBundle(t *testing.T) {
	keyFile := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyFile, []byte(strings.Repeat("24", 32)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if err := run([]string{"summarize", "--key-file", keyFile, storedFixture}, &stdout, &stderr); err != nil {
		t.Fatalf("summarize: %v", err)
	}
	var report struct {
		Sequence uint64            `json:"sequence"`
		Tracks   []json.RawMessage `json:"tracks"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil || report.Sequence != 7 || len(report.Tracks) == 0 {
		t.Fatalf("report: %+v err=%v\n%s", report, err, stdout.String())
	}
}

func TestEncryptedBundleNeedsKey(t *testing.T) {
	t.Setenv(keyEnvironment, "")
	err := run([]string{"summarize", storedFixture}, &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "needs a key") {
		t.Fatalf("error = %v", err)
	}
}

func TestReplayDefaultDurationIncludesFractionalFinalPacket(t *testing.T) {
	t.Setenv(keyEnvironment, "")
	stored, err := os.ReadFile(storedFixture)
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := recordingbundle.Open(stored, bytes.Repeat([]byte{0x24}, 32))
	if err != nil {
		t.Fatal(err)
	}
	bundle.Manifest.MediaRange = recordingbundle.TimeRange{StartMilliseconds: 100, EndMilliseconds: 133}
	bundle.Manifest.MonotonicRange = bundle.Manifest.MediaRange
	bundle.TrackTimeline, bundle.LayoutTimeline, bundle.Gaps = nil, nil, nil
	bundle.Fragments = []recordingbundle.RTPFragment{{
		Track:   recordingbundle.TrackIdentity{TrackID: "track-0", Epoch: 1, MID: "0", Codec: "vp8", Layer: "high"},
		Packets: []recordingbundle.RTPPacket{{SequenceNumber: 1, ExtendedSequenceNumber: 1, Timestamp: 12001, SSRC: 1, PayloadType: 96, Marker: true, Payload: []byte{0x10, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0}}},
	}}
	encoded, err := recordingbundle.Encode(bundle)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "test.bundle")
	if err := os.WriteFile(path, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	for _, duration := range []string{"", "134"} {
		var stdout, stderr bytes.Buffer
		args := []string{"replay"}
		if duration != "" {
			args = append(args, "--duration-ms", duration)
		}
		args = append(args, path)
		if err := run(args, &stdout, &stderr); err != nil {
			t.Fatal(err)
		}
		var results []recordingdecode.TrackReplay
		if err := json.Unmarshal(stdout.Bytes(), &results); err != nil {
			t.Fatal(err)
		}
		t.Logf("duration=%q replay=%+v", duration, results[0])
		if results[0].AssembledFrames != 1 {
			t.Errorf("duration=%q excluded final stored packet", duration)
		}
	}
}
