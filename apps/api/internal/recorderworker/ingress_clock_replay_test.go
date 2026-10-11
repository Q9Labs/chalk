package recorderworker

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

// Replay the exact admitted development packets and received reports so a
// before/after comparison cannot be confounded by a second network run.
func TestIngressClockReplay(t *testing.T) {
	root := os.Getenv("INGRESS_REPLAY_DIRECTORY")
	if root == "" {
		t.Skip("private development ingress replay only")
	}
	output := filepath.Join(root, "reclocked")
	if value := os.Getenv("INGRESS_REPLAY_OUTPUT"); value != "" {
		output = value
	}
	if err := os.Mkdir(output, 0700); err != nil {
		t.Fatal(err)
	}
	paths, err := filepath.Glob(filepath.Join(root, "*.metadata.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		name := strings.TrimSuffix(filepath.Base(path), ".metadata.json")
		kind := captureplane.TrackKindVideo
		if strings.Contains(name, "microphone") {
			kind = captureplane.TrackKindAudio
		}
		var rows []ingressRow
		readIngressReplay(t, filepath.Join(root, name+".jsonl"), func(decoder *json.Decoder) error {
			var row ingressRow
			if err := decoder.Decode(&row); err != nil {
				return err
			}
			rows = append(rows, row)
			return nil
		})
		var reports []struct {
			ArrivalNS int64  `json:"arrival_ns"`
			SSRC      uint32 `json:"ssrc"`
			NTP       uint64 `json:"ntp"`
			RTP       uint32 `json:"rtp"`
		}
		readIngressReplay(t, filepath.Join(root, name+".rtcp.jsonl"), func(decoder *json.Decoder) error {
			var row struct {
				ArrivalNS int64  `json:"arrival_ns"`
				SSRC      uint32 `json:"ssrc"`
				NTP       uint64 `json:"ntp"`
				RTP       uint32 `json:"rtp"`
			}
			if err := decoder.Decode(&row); err != nil {
				return err
			}
			reports = append(reports, row)
			return nil
		})
		sort.SliceStable(reports, func(i, j int) bool { return reports[i].ArrivalNS < reports[j].ArrivalNS })
		var clock captureTrackClock
		index := 0
		for i := range rows {
			row := &rows[i]
			for index < len(reports) && reports[index].ArrivalNS <= row.ArrivalNS {
				report := reports[index]
				clock.observeSenderReport(&rtcp.SenderReport{SSRC: report.SSRC, NTPTime: report.NTP, RTPTime: report.RTP}, kind)
				index++
			}
			if !row.Admitted {
				continue
			}
			arrival := row.ArrivalNS / 1000000
			if !clock.started && row.MediaMS != nil {
				arrival = *row.MediaMS
			}
			media, timestamp := clock.normalize(&rtp.Packet{Header: rtp.Header{SSRC: row.SSRC, Timestamp: row.Timestamp, SequenceNumber: row.Sequence}}, kind, arrival)
			row.MediaMS = &media
			row.NormalizedTimestamp = &timestamp
		}
		file, err := os.OpenFile(filepath.Join(output, name+".jsonl"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		encoder := json.NewEncoder(file)
		for _, row := range rows {
			if err := encoder.Encode(row); err != nil {
				t.Fatal(err)
			}
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		t.Logf("%s largest_correction_ms=%d total_correction_ms=%d", name, clock.largestCorrectionMS, clock.correctionMS)
	}
}

func readIngressReplay(t *testing.T, path string, read func(*json.Decoder) error) {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	for {
		err := read(decoder)
		if err == io.EOF {
			return
		}
		if err != nil {
			t.Fatal(err)
		}
	}
}
