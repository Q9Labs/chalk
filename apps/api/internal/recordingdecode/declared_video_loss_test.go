package recordingdecode

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func TestDeclaredVideoLossRequiresMissingPictures(t *testing.T) {
	state := &sourceState{presentation: recordingpresentation.MediaSource{SourceID: "camera", Kind: recordingpresentation.MediaKindCamera}, observedGaps: []observedGap{{500, 9_500, "attempt_recovery"}}}
	quality := vp8Quality{}
	timestamps := []uint64{0, 3_000, 6_000, 900_000, 903_000, 1_080_000}
	gaps := declaredVideoLoss(state, timestamps, 12_000, []Discontinuity{sourceDiscontinuity(state, 100, 10_000, "packet_loss")})
	quality.result(state, timestamps, 12_000, gaps)
	if state.degradation.FrozenMS != 9_900 || state.degradation.Recoveries != 1 {
		t.Fatalf("declared loss must not disappear or double-count: %+v", state.degradation)
	}
	timestamps = nil
	for tick := uint64(0); tick < 1_080_000; tick += 3_000 {
		timestamps = append(timestamps, tick)
	}
	gaps = declaredVideoLoss(state, timestamps, 12_000, nil)
	quality.result(state, timestamps, 12_000, gaps)
	if state.degradation.FrozenMS != 0 || state.degradation.Recoveries != 0 {
		t.Fatalf("receipt hid uninterrupted video: %+v", state.degradation)
	}
}

func TestDeclaredCaptureOutageHoldsVideoTailWithoutSequenceGap(t *testing.T) {
	root := t.TempDir()
	packets := packetizeVP8(generatedVP8Keyframes(t, root, "320x240"))
	request := policyBundleRequest(t, [][]recordingbundle.RTPPacket{packets}, 2_000)
	encoded, err := os.ReadFile(request.Bundles[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := recordingbundle.Decrypt(request.DataKeys[0].Plaintext, encoded)
	if err != nil {
		t.Fatal(err)
	}
	bundle.Gaps = []recordingbundle.Gap{{StartMonotonicMilliseconds: 500, EndMonotonicMilliseconds: 1_000, StartMediaMilliseconds: 500, EndMediaMilliseconds: 1_000, Reason: "capture_unavailable"}}
	encoded, err = recordingbundle.Encrypt(request.DataKeys[0].Plaintext, bundle)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(request.Bundles[0].Path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	request.Bundles[0].ExpectedSHA256 = recordingbundle.ObjectChecksumHex(encoded)
	result, err := Write(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.Index.Sources[0].EndMS != request.DurationMS || result.VideoDegradation[0].FrozenMS < 1_500 || result.VideoDegradation[0].DroppedFrames != 0 {
		t.Fatalf("declared outage lost its hold/counters: %+v %+v", result.Index.Sources, result.VideoDegradation)
	}
	if _, err := os.Stat(filepath.Join(request.OutputDirectory, result.Index.Sources[0].Path)); err != nil {
		t.Fatal(err)
	}
}
