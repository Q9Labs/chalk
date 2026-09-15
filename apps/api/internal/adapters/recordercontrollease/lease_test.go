package recordercontrollease

import (
	"path/filepath"
	"testing"
)

func TestLeaseRejectsDuplicateOwnerAndAllowsRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "capture", "journal.json")
	first, err := Acquire(path)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := Acquire(path); err == nil {
		second.Close()
		t.Fatal("duplicate process acquired state")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := Acquire(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Close(); err != nil {
		t.Fatal(err)
	}
}
