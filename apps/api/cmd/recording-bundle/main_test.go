package main

import (
	"bytes"
	"encoding/json"
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
