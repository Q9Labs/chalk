package recorderworker

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
)

type captureReportTestTrack struct {
	*captureTestTrack
	reports     [][]rtcp.Packet
	readErr     error
	deadlineErr error
}

func (t *captureReportTestTrack) ReadRTCP() ([]rtcp.Packet, interceptor.Attributes, error) {
	if len(t.reports) == 0 {
		return nil, nil, t.readErr
	}
	packets := t.reports[0]
	t.reports = t.reports[1:]
	return packets, nil, nil
}

func (t *captureReportTestTrack) SetRTCPReadDeadline(time.Time) error { return t.deadlineErr }

func TestCaptureSenderReportReaderFailureDoesNotEndTheAttempt(t *testing.T) {
	report := &rtcp.SenderReport{SSRC: 7, NTPTime: 1 << 32, RTPTime: 90_000}
	cases := map[string]struct {
		track       *captureReportTestTrack
		wantReports int
	}{
		"read fails after one report": {
			track:       &captureReportTestTrack{captureTestTrack: &captureTestTrack{}, reports: [][]rtcp.Packet{{report}}, readErr: errors.New("malformed RTCP")},
			wantReports: 1,
		},
		"deadline cannot be set": {
			track: &captureReportTestTrack{captureTestTrack: &captureTestTrack{}, deadlineErr: errors.New("receiver closed")},
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			events := make(chan captureRuntimeEvent, 4)
			stop := startCaptureSenderReports(context.Background(), "0", testCase.track, time.Millisecond, events)
			stop()
			close(events)
			reports := 0
			for event := range events {
				if event.err != nil {
					t.Fatalf("report reader failure reached the Capture attempt: %v", event.err)
				}
				if event.report != nil {
					reports++
				}
			}
			if reports != testCase.wantReports {
				t.Fatalf("reports delivered = %d, want %d", reports, testCase.wantReports)
			}
		})
	}
}
