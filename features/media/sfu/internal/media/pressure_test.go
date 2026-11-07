package media

import (
	"testing"
	"time"
)

func TestALateControlTickIsAStallAndPressureFadesAfterTheHold(t *testing.T) {
	var p hostPressure
	for tick := range 10 {
		if _, stalled := p.controlTick(at(time.Duration(tick) * allocationInterval)); stalled {
			t.Fatalf("tick %d on time reads as a stall", tick)
		}
	}
	if p.active(at(time.Second)) {
		t.Fatal("a node that ticks on time shows pressure")
	}
	late := at(time.Second + 450*time.Millisecond)
	from, stalled := p.controlTick(late)
	if !stalled || from != at(900*time.Millisecond) {
		t.Fatalf("a tick 450 ms after the last gave stall from %v, %v", from, stalled)
	}
	if !p.active(late) || !p.active(late+int64(pressureHold)-1) {
		t.Fatal("pressure did not hold after the stall")
	}
	if p.active(late + int64(pressureHold)) {
		t.Fatal("pressure outlived its hold")
	}
}

func TestStealRaisesPressureAndSustainedStealCannotFreezeForever(t *testing.T) {
	var p hostPressure
	now := at(0)
	p.stealSample(now, stealPressure-1)
	if p.active(now) {
		t.Fatal("quiet steal read as pressure")
	}
	for second := range 30 {
		now = at(time.Duration(second) * time.Second)
		p.stealSample(now, 20)
	}
	if p.active(now) {
		t.Fatalf("30 s of steal still reads as pressure after %v", pressureMax)
	}
	p.stealSample(at(0), 0)
	p.stealSample(now+int64(pressureHold), 20)
	if !p.active(now + int64(pressureHold)) {
		t.Fatal("pressure did not return after a quiet spell")
	}
}

func TestTheNodeCountsHowLongPressureHeld(t *testing.T) {
	var p hostPressure
	p.controlTick(at(0))
	p.controlTick(at(450 * time.Millisecond)) // a stall: pressure from 0 to 450 ms plus the hold
	if got := p.settle(at(time.Minute)); got != 450*time.Millisecond+pressureHold {
		t.Fatalf("one stall held pressure for %v, want %v", got, 450*time.Millisecond+pressureHold)
	}
	// Steal for a long stretch counts to the cap and no further.
	for second := range 30 {
		p.stealSample(at(10*time.Second+time.Duration(second)*time.Second), 20)
	}
	if got := p.settle(at(time.Minute)); got != 450*time.Millisecond+pressureHold+pressureMax {
		t.Fatalf("30 s of steal added %v, want the cap %v", got-450*time.Millisecond-pressureHold, pressureMax)
	}
}

func TestOnlyTheFirstFewTransportsProbeAtOnce(t *testing.T) {
	budget := probeBudget{slots: maxProbes}
	granted := 0
	for range 18 {
		if budget.take() {
			granted++
		}
	}
	if granted != maxProbes {
		t.Fatalf("%d of 18 transports got to probe, want %d", granted, maxProbes)
	}
}

func probingSession(t *testing.T, now int64) *Session {
	t.Helper()
	return &Session{transport: probingTransport(t, 4e6, now)}
}

func TestTheNodeTellsEveryTransportItsPressureAndStopsAfterTheMaximum(t *testing.T) {
	node := newTestNode(t, nil)
	now := monotonic()
	sessions := []*Session{probingSession(t, now), probingSession(t, now)}
	node.shareHostState(sessions, now)
	for _, session := range sessions {
		if !session.transport.probing() || session.transport.estimate(now).pressured {
			t.Fatal("a calm node pressured a transport")
		}
	}
	node.pressure.stealSample(now, 10)
	node.shareHostState(sessions, now)
	for _, session := range sessions {
		if session.transport.probing() || !session.transport.estimate(now).pressured {
			t.Fatal("a stalled node left a transport probing or unaware")
		}
	}
	// Steal that never lets up cannot freeze the transports for good.
	for at := now; at < now+int64(2*pressureMax); at += int64(time.Second) {
		node.pressure.stealSample(at, 10)
		node.shareHostState(sessions, at)
	}
	if end := now + int64(2*pressureMax); sessions[0].transport.estimate(end).pressured {
		t.Fatal("unbroken steal pressured a transport past the maximum")
	}
}

func TestRunningProbesCountAgainstTheNodesProbeBudget(t *testing.T) {
	node := newTestNode(t, nil)
	now := monotonic()
	var sessions []*Session
	for range 5 {
		sessions = append(sessions, probingSession(t, now))
	}
	budget := node.shareHostState(sessions, now)
	if budget.take() {
		t.Fatal("five probes were running and the node gave out another slot")
	}
	idle := []*Session{{transport: probingTransport(t, 4e6, now)}}
	idle[0].transport.abandonProbe()
	budget = node.shareHostState(idle, now)
	if !budget.take() || !budget.take() || budget.take() {
		t.Fatal("an idle node must give out exactly maxProbes slots")
	}
}

func TestAStallThatBeginsBeforeTheRunItFollowsStillCountsItsWholeSpan(t *testing.T) {
	var p hostPressure
	p.controlTick(at(time.Second))
	p.stealSample(at(3*time.Second), 20) // pressure from 2 s to 5 s
	p.controlTick(at(6 * time.Second))   // a stall that began at 1 s: pressure from 1 s to 8 s
	if got := p.settle(at(9 * time.Second)); got != 7*time.Second {
		t.Fatalf("pressure counted %v, want the 7 s from 1 s to 8 s", got)
	}
}
