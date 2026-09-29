package recorderworker

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

// The writer deliberately retains its old binding: privacy must not depend on
// the plan consumer having reconciled and canceled that reader yet.
func TestCapturePacketPrivacyBeforePlanReconciliation(t *testing.T) {
	origin := time.UnixMilli(1000).UTC()
	writer, storage := newCaptureTestWriter(t, origin)
	track := &captureTestTrack{capture: capturePlanWatchPulledTrack(t, "0", "privacy"), codec: "opus"}
	authority := captureTestPlanAtEpoch(t, 2, 1, origin).Authority()
	active := capturePlanWatchPlan(t, authority, 1, origin, captureplan.StopStateRunning, track.capture)
	off := capturePlanWatchPlan(t, authority, 2, origin, captureplan.StopStateRunning)
	plans := &captureTestPlanSource{plan: active}
	writer.attempt.plans = plans
	writer.attempt.ready = true
	activateCaptureTestTrack(writer, track, origin, 1)
	consume := func(sequence uint16) {
		t.Helper()
		packet := &rtp.Packet{Header: rtp.Header{SequenceNumber: sequence, Timestamp: uint32(sequence) * 960}, Payload: []byte{byte(sequence)}}
		if err := writer.attempt.consumePacket(context.Background(), writer, captureRuntimeEvent{track: track, packet: packet, at: origin.Add(time.Duration(sequence) * time.Millisecond)}); err != nil {
			t.Fatal(err)
		}
	}
	consume(1)
	plans.plan = off
	started := time.Now()
	for sequence := uint16(2); sequence <= 101; sequence++ {
		consume(sequence)
	}
	mutedGateTime := time.Since(started)
	plans.plan = active
	consume(102)
	if err := writer.close(recordingbundle.CloseReasonFinalStop, origin.Add(103*time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	mutedPackets, activePackets := 0, 0
	for _, upload := range storage.uploadHistory {
		bundle, err := recordingbundle.Decrypt(storage.key, upload.Body)
		if err != nil {
			t.Fatal(err)
		}
		for _, fragment := range bundle.Fragments {
			for _, packet := range fragment.Packets {
				if packet.SequenceNumber > 1 && packet.SequenceNumber < 102 {
					mutedPackets++
				} else {
					activePackets++
				}
			}
		}
	}
	t.Logf("privacy-probe muted_packets=%d active_packets=%d packet_gate_ms=%.6f", mutedPackets, activePackets, float64(mutedGateTime.Nanoseconds())/1e6/100)
	if mutedPackets != 0 || activePackets != 2 {
		t.Errorf("stored muted packets = %d, active packets = %d; want 0 and 2", mutedPackets, activePackets)
	}
}

func TestCapturePacketPrivacyFailsClosedWhenAuthorityIsUnavailable(t *testing.T) {
	origin := time.UnixMilli(1000).UTC()
	writer, _ := newCaptureTestWriter(t, origin)
	track := &captureTestTrack{capture: capturePlanWatchPulledTrack(t, "0", "privacy"), codec: "opus"}
	writer.attempt.plans = &capturePrivacyUnavailablePlan{}
	writer.attempt.ready = true
	activateCaptureTestTrack(writer, track, origin, 1)
	err := writer.attempt.consumePacket(context.Background(), writer, captureRuntimeEvent{track: track, packet: &rtp.Packet{Payload: []byte{1}}, at: origin})
	if !errors.Is(err, captureplan.ErrRepositoryUnavailable) || writer.assembler != nil {
		t.Fatalf("authority failure = %v, assembler = %v; want no media stored", err, writer.assembler)
	}
}

type capturePrivacyUnavailablePlan struct{}

func (*capturePrivacyUnavailablePlan) WaitForPlan(context.Context, captureplan.WaitInput) (captureplan.Plan, error) {
	return captureplan.Plan{}, captureplan.ErrRepositoryUnavailable
}

func TestCapturePrivacyBatchReadsAuthorityAfterCollection(t *testing.T) {
	origin := time.UnixMilli(1000).UTC()
	writer, _ := newCaptureTestWriter(t, origin)
	track := &captureTestTrack{capture: capturePlanWatchPulledTrack(t, "0", "privacy"), codec: "opus"}
	authority := captureTestPlanAtEpoch(t, 2, 1, origin).Authority()
	plans := &capturePrivacyBatchPlan{plan: capturePlanWatchPlan(t, authority, 1, origin, captureplan.StopStateRunning, track.capture)}
	writer.attempt.plans = plans
	writer.attempt.ready = true
	activateCaptureTestTrack(writer, track, origin, 1)
	events := make(chan captureRuntimeEvent, 100)
	event := captureRuntimeEvent{track: track, packet: &rtp.Packet{Payload: []byte{1}}, at: origin}
	for range 100 {
		events <- event
	}
	// The mute commits while the worker is collecting, before its one read.
	plans.plan = capturePlanWatchPlan(t, authority, 2, origin, captureplan.StopStateRunning)
	if err := writer.attempt.consumeQueuedPackets(context.Background(), writer, event, events, func(captureRuntimeEvent) bool { return true }); err != nil {
		t.Fatal(err)
	}
	if plans.reads != 1 || writer.assembler != nil {
		t.Fatalf("authority reads = %d, assembler = %v; want one read and no muted media", plans.reads, writer.assembler)
	}
}

type capturePrivacyBatchPlan struct {
	plan  captureplan.Plan
	reads int
}

func (p *capturePrivacyBatchPlan) WaitForPlan(context.Context, captureplan.WaitInput) (captureplan.Plan, error) {
	p.reads++
	return p.plan, nil
}
