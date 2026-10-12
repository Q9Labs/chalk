package recorderworker

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

// Retained development ingress, 58–75 seconds: disable h, retain l. Only
// relative arrival/RTP/sequence values and shifted NTP remain; no identifiers
// or media. The consecutive packets at the switch lose 1,719 ms of RTP time.
func TestCaptureTrackClockRetainedLayerSwitch(t *testing.T) {
	data, err := os.ReadFile("testdata/capture_clock_layer_switch.json")
	if err != nil {
		t.Fatal(err)
	}
	var events []struct {
		AtMS     int64  `json:"at_ms"`
		RTP      uint32 `json:"rtp"`
		Sequence uint16 `json:"sequence"`
		NTP      uint64 `json:"ntp"`
	}
	if err := json.Unmarshal(data, &events); err != nil {
		t.Fatal(err)
	}
	var clock captureTrackClock
	var lag int64
	for _, event := range events {
		if event.NTP != 0 {
			clock.observeSenderReport(&rtcp.SenderReport{NTPTime: event.NTP, RTPTime: event.RTP}, captureplane.TrackKindVideo)
			continue
		}
		media, _ := clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: event.RTP, SequenceNumber: event.Sequence}}, captureplane.TrackKindVideo, event.AtMS)
		lag = event.AtMS - media
	}
	if lag < -100 || lag > 100 || clock.largestCorrectionMS < 1600 || clock.largestCorrectionMS > 1800 {
		t.Fatalf("retained layer switch: end lag=%d largest correction=%d", lag, clock.largestCorrectionMS)
	}
}

func TestCaptureTrackClockPreservesStallTime(t *testing.T) {
	var camera, microphone captureTrackClock
	for sourceMS := int64(0); sourceMS <= 9000; sourceMS += 100 {
		arrival := sourceMS
		if sourceMS >= 1000 {
			arrival += 2000
		}
		if sourceMS%1000 == 0 {
			camera.observeSenderReport(clockTestReport(arrival, uint32(sourceMS*90)), captureplane.TrackKindVideo)
			microphone.observeSenderReport(clockTestReport(arrival, uint32(arrival*48)), captureplane.TrackKindAudio)
		}
		picture := &rtp.Packet{Header: rtp.Header{Timestamp: uint32(sourceMS * 90)}}
		sound := &rtp.Packet{Header: rtp.Header{Timestamp: uint32(arrival * 48)}}
		videoMS, _ := camera.normalize(picture, captureplane.TrackKindVideo, arrival)
		audioMS, _ := microphone.normalize(sound, captureplane.TrackKindAudio, arrival)
		if sourceMS >= 6000 && (videoMS != arrival || audioMS != videoMS) {
			t.Fatalf("after stall: camera=%d microphone=%d arrival=%d", videoMS, audioMS, arrival)
		}
	}
}

func TestCaptureTrackClockLateDeliveryCatchesUpWithoutCorrection(t *testing.T) {
	var clock captureTrackClock
	for sourceMS := int64(0); sourceMS <= 5000; sourceMS += 100 {
		arrival := sourceMS
		if sourceMS >= 1000 && sourceMS < 3000 {
			arrival = 3000
		}
		if sourceMS%1000 == 0 {
			clock.observeSenderReport(clockTestReport(sourceMS, uint32(sourceMS*90)), captureplane.TrackKindVideo)
		}
		media, timestamp := clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: uint32(sourceMS * 90)}}, captureplane.TrackKindVideo, arrival)
		if media != sourceMS || timestamp != uint32(sourceMS*90) {
			t.Fatalf("source=%d arrival=%d media=%d timestamp=%d", sourceMS, arrival, media, timestamp)
		}
	}
}

func TestCaptureTrackClockJitterDoesNotMoveClock(t *testing.T) {
	var clock captureTrackClock
	for sourceMS := int64(0); sourceMS <= 10000; sourceMS += 100 {
		jitter := int64(0)
		if sourceMS%700 == 100 {
			jitter = 400
		} else if sourceMS%300 == 100 {
			jitter = 80
		}
		media, _ := clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: uint32(sourceMS * 90)}}, captureplane.TrackKindVideo, sourceMS+jitter)
		if media != sourceMS {
			t.Fatalf("jitter moved clock: source=%d media=%d", sourceMS, media)
		}
	}
}

func TestCaptureTrackClockTimestampWrapAndLatePacket(t *testing.T) {
	var clock captureTrackClock
	base := uint32(0xffff0000)
	for sourceMS := int64(0); sourceMS <= 5000; sourceMS += 100 {
		media, timestamp := clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: base + uint32(sourceMS*90)}}, captureplane.TrackKindVideo, sourceMS+500)
		if media != sourceMS+500 || timestamp != uint32((sourceMS+500)*90) {
			t.Fatalf("wrap source=%d media=%d timestamp=%d", sourceMS, media, timestamp)
		}
	}
	media, _ := clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: base + 90_000}}, captureplane.TrackKindVideo, 5600)
	if media != 1500 {
		t.Fatalf("late packet changed timestamp: %d", media)
	}
}

func TestCaptureTrackClockAudioAndPacketLossKeepElapsedTime(t *testing.T) {
	for _, kind := range []captureplane.TrackKind{captureplane.TrackKindAudio, captureplane.TrackKindVideo} {
		t.Run(string(kind), func(t *testing.T) {
			var clock captureTrackClock
			rate := captureClockRate(kind)
			for _, sourceMS := range []int64{0, 20, 40, 2060, 2080, 2100, 5000} {
				media, timestamp := clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: uint32(sourceMS * rate / 1000)}}, kind, sourceMS)
				if media != sourceMS || timestamp != uint32(sourceMS*rate/1000) {
					t.Fatalf("loss cut elapsed time: source=%d media=%d", sourceMS, media)
				}
			}
		})
	}
}

func BenchmarkCaptureTrackClock(b *testing.B) {
	for _, stalled := range []bool{false, true} {
		name := "healthy"
		if stalled {
			name = "compressed-stall"
		}
		b.Run(name, func(b *testing.B) {
			for _, kind := range []captureplane.TrackKind{captureplane.TrackKindVideo, captureplane.TrackKindAudio} {
				b.Run(string(kind), func(b *testing.B) {
					var clock captureTrackClock
					packet := &rtp.Packet{}
					rate := captureClockRate(kind)
					b.ReportAllocs()
					b.ReportMetric(float64(reflect.TypeOf(clock).Size()), "state-bytes")
					for i := 0; i < b.N; i++ {
						// Four packets per picture; a one-second compressed stall every minute.
						sourceMS := int64(i/4) * 20
						arrival := sourceMS
						if stalled {
							arrival += sourceMS / 60000 * 1000
						}
						packet.Timestamp = uint32(sourceMS * rate / 1000)
						packet.SequenceNumber = uint16(i)
						if i%200 == 0 {
							clock.observeSenderReport(clockTestReport(arrival, packet.Timestamp), kind)
						}
						clock.normalize(packet, kind, arrival)
					}
					b.ReportMetric(float64(cap(clock.corrections))*float64(reflect.TypeOf(captureClockCorrection{}).Size()), "correction-cap-bytes")
				})
			}
		})
	}
}

func clockTestReport(wallMS int64, timestamp uint32) *rtcp.SenderReport {
	return &rtcp.SenderReport{NTPTime: ((uint64(3900000000) + uint64(wallMS/1000)) << 32) + uint64(wallMS%1000)*(1<<32)/1000, RTPTime: timestamp}
}

func TestCaptureTrackClockCorrectionDoesNotSplitOrRetimestampAnOlderPicture(t *testing.T) {
	var clock captureTrackClock
	clock.observeSenderReport(clockTestReport(0, 0), captureplane.TrackKindVideo)
	clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: 0, SequenceNumber: 1}}, captureplane.TrackKindVideo, 0)
	clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: 90000, SequenceNumber: 2}}, captureplane.TrackKindVideo, 1000)
	clock.observeSenderReport(clockTestReport(3000, 90000), captureplane.TrackKindVideo)
	clock.observeSenderReport(clockTestReport(4000, 180000), captureplane.TrackKindVideo)
	clock.observeSenderReport(clockTestReport(5000, 270000), captureplane.TrackKindVideo)
	clock.observeSenderReport(clockTestReport(6000, 360000), captureplane.TrackKindVideo)
	clock.observeSenderReport(clockTestReport(7000, 450000), captureplane.TrackKindVideo)
	media, _ := clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: 90000, SequenceNumber: 3}}, captureplane.TrackKindVideo, 4000)
	if media != 1000 {
		t.Fatalf("split older picture: %d", media)
	}
	media, _ = clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: 180000, SequenceNumber: 5}}, captureplane.TrackKindVideo, 4000)
	if media != 2000 {
		t.Fatalf("correction did not wait for persistent packet lag: %d", media)
	}
	media, _ = clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: 450000, SequenceNumber: 6}}, captureplane.TrackKindVideo, 7000)
	if media != 7000 {
		t.Fatalf("new picture not corrected: %d", media)
	}
	media, _ = clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: 90000, SequenceNumber: 4}}, captureplane.TrackKindVideo, 7001)
	if media != 1000 {
		t.Fatalf("late fragment was retimestamped: %d", media)
	}
}

func TestCaptureTrackClockIgnoresTransientAndReorderedSenderReports(t *testing.T) {
	var clock captureTrackClock
	clock.normalize(&rtp.Packet{}, captureplane.TrackKindVideo, 0)
	clock.observeSenderReport(clockTestReport(0, 0), captureplane.TrackKindVideo)
	clock.observeSenderReport(clockTestReport(3000, 90000), captureplane.TrackKindVideo)
	clock.observeSenderReport(clockTestReport(4000, 360000), captureplane.TrackKindVideo)
	clock.observeSenderReport(clockTestReport(3000, 90000), captureplane.TrackKindVideo)
	media, _ := clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: 450000}}, captureplane.TrackKindVideo, 5000)
	if media != 5000 {
		t.Fatalf("transient report moved clock: %d", media)
	}
}

func TestCaptureTrackClockReportExtrapolationAndDeliveryCatchUpTogether(t *testing.T) {
	var clock captureTrackClock
	clock.normalize(&rtp.Packet{}, captureplane.TrackKindVideo, 0)
	clock.observeSenderReport(clockTestReport(0, 0), captureplane.TrackKindVideo)
	for sourceMS := int64(100); sourceMS <= 10000; sourceMS += 100 {
		arrival := sourceMS
		reportTS := uint32(sourceMS * 90)
		if sourceMS >= 3000 && sourceMS < 6000 {
			arrival += 500
			reportTS -= 45000
		}
		if sourceMS%1000 == 0 {
			clock.observeSenderReport(clockTestReport(sourceMS, reportTS), captureplane.TrackKindVideo)
		}
		media, _ := clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: uint32(sourceMS * 90), SequenceNumber: uint16(sourceMS / 100)}}, captureplane.TrackKindVideo, arrival)
		if media != sourceMS {
			t.Fatalf("a three-second transient moved the clock: %d != %d", media, sourceMS)
		}
	}
}

func TestCaptureTrackClockAudioSenderClockStall(t *testing.T) {
	var clock captureTrackClock
	for sourceMS := int64(0); sourceMS <= 9000; sourceMS += 20 {
		arrival := sourceMS
		if sourceMS >= 1000 {
			arrival += 2000
		}
		if sourceMS%1000 == 0 {
			clock.observeSenderReport(clockTestReport(arrival, uint32(sourceMS*48)), captureplane.TrackKindAudio)
		}
		media, _ := clock.normalize(&rtp.Packet{Header: rtp.Header{Timestamp: uint32(sourceMS * 48), SequenceNumber: uint16(sourceMS / 20)}}, captureplane.TrackKindAudio, arrival)
		if sourceMS >= 6000 && media != arrival {
			t.Fatalf("audio clock stalled: media=%d arrival=%d", media, arrival)
		}
	}
}
