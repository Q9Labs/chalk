package recordingdecode

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func TestVP8ResolutionChangesPreserveRecordedFrames(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	cases := []struct {
		name  string
		sizes [][2]int
	}{
		{"odd_first", [][2]int{{240, 135}, {320, 180}}},
		{"even_then_odd", [][2]int{{320, 180}, {241, 135}}},
		{"low_then_high_detail", [][2]int{{160, 90}, {1280, 720}}},
		{"portrait_then_landscape", [][2]int{{135, 241}, {640, 360}}},
		{"several_switches_and_tiny_layers", [][2]int{{3, 3}, {240, 135}, {1280, 720}, {135, 241}, {2, 3}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			var frames [][]byte
			for index, size := range tc.sizes {
				path := filepath.Join(root, fmt.Sprintf("%d.ivf", index))
				args := []string{"-v", "error", "-f", "lavfi", "-i", fmt.Sprintf("testsrc=size=%dx%d:rate=30", size[0], size[1]), "-frames:v", "1", "-c:v", "libvpx", "-pix_fmt", "yuv420p", "-threads", "1", "-f", "ivf", path}
				if output, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
					t.Fatalf("generate VP8: %v: %s", err, output)
				}
				frames = append(frames, readIVFFrames(t, path)[0])
			}
			request := policyBundleRequest(t, [][]recordingbundle.RTPPacket{packetizeVP8(frames)}, 1000)
			result, err := Write(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Index.Sources) != 1 {
				t.Fatalf("sources: %+v", result.Index.Sources)
			}
			path := filepath.Join(request.OutputDirectory, result.Index.Sources[0].Path)
			data, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=width,height", "-of", "json", path).Output()
			if err != nil {
				t.Fatal(err)
			}
			var probe struct {
				Frames []struct {
					Width  int
					Height int
				}
			}
			if err := json.Unmarshal(data, &probe); err != nil {
				t.Fatal(err)
			}
			if len(probe.Frames) != len(tc.sizes) {
				t.Fatalf("frames: %s", data)
			}
			for i, frame := range probe.Frames {
				if frame.Width != tc.sizes[i][0] || frame.Height != tc.sizes[i][1] {
					t.Fatalf("frame %d shrunk/changed: %+v, want %v", i, frame, tc.sizes[i])
				}
			}
			// Exact compressed-frame equality proves later high-layer detail is retained,
			// not merely upscaled back to a high-resolution header after normalization.
			copied := filepath.Join(root, "copied.ivf")
			if output, err := exec.Command("ffmpeg", "-v", "error", "-i", path, "-c:v", "copy", "-f", "ivf", copied).CombinedOutput(); err != nil {
				t.Fatalf("extract frames: %v: %s", err, output)
			}
			actual := readIVFFrames(t, copied)
			for i, frame := range frames {
				if !bytes.Equal(frame, actual[i]) {
					t.Fatalf("frame %d was re-encoded", i)
				}
			}
			// The compatibility renderer still needs a fixed canvas, but its target must
			// cover every layer and support yuv420p even for a single odd-sized segment.
			request.VideoPassthrough = false
			request.OutputDirectory = filepath.Join(root, "legacy")
			if _, err := Write(context.Background(), request); err != nil {
				t.Fatalf("fixed-size compatibility decode: %v", err)
			}
		})
	}
}
