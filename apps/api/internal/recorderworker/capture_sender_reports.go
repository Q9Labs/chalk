package recorderworker

import (
	"context"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
)

type captureSenderReportTrack interface {
	ReadRTCP() ([]rtcp.Packet, interceptor.Attributes, error)
	SetRTCPReadDeadline(time.Time) error
}

// Reports only refine the track clock. A failed report read stops the
// refinement for that track; an error event here would end the Capture
// attempt, and the RTP reader already reports a dead track.
func startCaptureSenderReports(ctx context.Context, mid string, track CaptureMediaTrack, deadline time.Duration, events chan<- captureRuntimeEvent) func() {
	reader, ok := track.(captureSenderReportTrack)
	if !ok {
		return func() {}
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ctx.Err() == nil {
			if err := reader.SetRTCPReadDeadline(time.Now().Add(deadline)); err != nil {
				return
			}
			packets, _, err := reader.ReadRTCP()
			if isCaptureReadTimeout(err) {
				continue
			}
			if err != nil {
				return
			}
			for _, packet := range packets {
				report, ok := packet.(*rtcp.SenderReport)
				if !ok {
					continue
				}
				if err := sendCaptureRuntimeEvent(ctx, events, captureRuntimeEvent{mid: mid, track: track, report: report, at: time.Now().UTC()}); err != nil {
					return
				}
			}
		}
	}()
	return func() { <-done }
}
