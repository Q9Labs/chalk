package recordingrender

import (
	"bytes"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestRenderCommitBindsQualityMetadata(t *testing.T) {
	input := commitInputForTest(t)
	original, err := CommitDigest(input)
	if err != nil {
		t.Fatal(err)
	}
	input.VideoDegradation = []recordingpipeline.VideoDegradation{{SourceID: "camera", Kind: "camera", FrozenMS: 1, DroppedFrames: 1, Recoveries: 1}}
	changed, err := CommitDigest(input)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(original, changed) {
		t.Fatal("quality metadata was not bound by commit digest")
	}
	input.CommitDigest = changed
	if err := input.Validate(); err != nil {
		t.Fatal(err)
	}
	input.VideoDegradation[0].FrozenMS++
	if err := input.Validate(); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("changed metadata reused committed digest: %v", err)
	}
	input.VideoDegradation[0].FrozenMS = input.DurationMillis + 1
	input.CommitDigest, err = CommitDigest(input)
	if err != nil {
		t.Fatal(err)
	}
	if err := input.Validate(); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("unbounded quality: %v", err)
	}
}
