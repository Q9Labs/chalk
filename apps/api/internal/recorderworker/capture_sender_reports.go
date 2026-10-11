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
				sendCaptureRuntimeEvent(ctx, events, captureRuntimeEvent{mid: mid, track: track, err: err})
				return
			}
			packets, _, err := reader.ReadRTCP()
			if isCaptureReadTimeout(err) {
				continue
			}
			if err != nil {
				sendCaptureRuntimeEvent(ctx, events, captureRuntimeEvent{mid: mid, track: track, err: err})
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
