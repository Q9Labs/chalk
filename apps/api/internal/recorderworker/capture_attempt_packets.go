package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
)

// Read authority only after collecting the batch. Reusing an earlier "on"
// decision for packets that arrive later would store media after a mute.
func (a *PionCaptureAttempt) consumeQueuedPackets(ctx context.Context, writer *captureBundleWriter, first captureRuntimeEvent, events <-chan captureRuntimeEvent, matches func(captureRuntimeEvent) bool) error {
	batch := []captureRuntimeEvent{first}
	timer := time.NewTimer(20 * time.Millisecond)
	defer timer.Stop()
collect:
	for len(batch) < 256 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			break collect
		case event, ok := <-events:
			if !ok {
				break collect
			}
			if matches(event) {
				batch = append(batch, event)
			}
		}
	}
	plan, err := a.packetAuthority(ctx)
	if err != nil {
		return err
	}
	for _, event := range batch {
		if event.err != nil {
			return errors.Join(event.err, writer.addTerminalGap(a.config.Now()))
		}
		if err := a.consumeAuthorizedPacket(ctx, writer, event, plan); err != nil {
			return err
		}
	}
	return nil
}

func (a *PionCaptureAttempt) consumeAuthorizedPacket(ctx context.Context, writer *captureBundleWriter, event captureRuntimeEvent, plan captureplan.Plan) error {
	if (event.packet == nil && event.report == nil) || event.track == nil {
		return fmt.Errorf("%w: empty RTP event", ErrInvalidCaptureAttempt)
	}
	if !capturePacketAllowed(plan, event.track.CaptureTrack()) {
		return nil
	}
	if event.report != nil {
		writer.addSenderReport(event.track, event.report)
		return nil
	}
	if !a.ready {
		origin := writer.firstPacketOrigin(event.at)
		if err := a.emitReadyAt(ctx, false, origin); err != nil {
			return err
		}
		writer.setOrigin(origin)
	}
	return writer.addPacket(ctx, event.track, event.packet, event.at)
}
