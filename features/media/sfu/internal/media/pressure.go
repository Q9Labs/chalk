package media

import "time"

// A host that loses its CPU for a few hundred milliseconds (a noisy neighbour
// shows as steal) delays every send and every feedback the node handles. What
// the estimator and the pacer then see (late arrivals, thin acknowledgements, a
// queue that backs up) describes the node, not the subscriber's path, so the
// node tells them. hostPressure raises that signal from the control loop's own
// lateness and from steal, and only the control loop touches it.
const (
	// stallGap is how late a control tick may come before the node counts the gap
	// as a stall. The loop ticks every allocationInterval.
	stallGap = 2 * allocationInterval
	// stealPressure is the steal, as a percent of one second of CPU, that counts as pressure.
	stealPressure = 5.0
	// pressureHold is how long pressure lasts after its latest sign, long enough for
	// feedback about the stalled packets to arrive and for the acknowledged rate to refill.
	pressureHold = 2 * time.Second
	// pressureMax bounds one unbroken run of pressure, so sustained steal, which the
	// guard answers by refusing Episodes, cannot freeze the allocator for good.
	pressureMax = 10 * time.Second
	// maxProbes is how many transports may probe at once. Every subscriber of a node
	// reaches the same need at the same moment, after a join or after a stall, and
	// their padding together would load the node more than any one path needs.
	maxProbes = 2
)

type hostPressure struct {
	lastTick int64
	since    int64 // start of the current run of pressure
	until    int64 // pressure lasts to here

	counted  int64         // pressure up to here is already in underFor
	underFor time.Duration // how long pressure has held since start

	stalls       uint64        // control-loop stalls since start
	longestStall time.Duration // the longest since the last takeLongest
}

// controlTick records one control tick at now. It reports the span the node
// could not run in when the tick came later than stallGap after the last one.
func (p *hostPressure) controlTick(now int64) (from int64, stalled bool) {
	last := p.lastTick
	p.lastTick = now
	if last == 0 || now-last <= int64(stallGap) {
		return 0, false
	}
	p.raise(last, now)
	p.stalls++
	p.longestStall = max(p.longestStall, time.Duration(now-last))
	return last, true
}

// takeLongest returns the longest stall since the last call and forgets it.
func (p *hostPressure) takeLongest() time.Duration {
	longest := p.longestStall
	p.longestStall = 0
	return longest
}

// stealSample records the steal of the latest second.
func (p *hostPressure) stealSample(now int64, percent float64) {
	if percent >= stealPressure {
		p.raise(now-int64(time.Second), now)
	}
}

func (p *hostPressure) raise(from, now int64) {
	p.settle(now)
	if now >= p.until {
		if p.until != 0 && from < p.since {
			// A late tick starts its stall before the run it follows.
			p.underFor += time.Duration(p.since - from)
		}
		p.since = from
	}
	p.until = now + int64(pressureHold)
}

// settle adds the pressure held up to now to underFor, so telemetry can say
// what share of the time the signal is on.
func (p *hostPressure) settle(now int64) time.Duration {
	end := min(now, p.until, p.since+int64(pressureMax))
	if start := max(p.counted, p.since); end > start {
		p.underFor += time.Duration(end - start)
	}
	p.counted = max(p.counted, end)
	return p.underFor
}

// active reports whether the node has shown pressure recently.
func (p *hostPressure) active(now int64) bool {
	return now < p.until && now-p.since < int64(pressureMax)
}

// end is when the current pressure stops, or 0 while there is none.
func (p *hostPressure) end(now int64) int64 {
	if !p.active(now) {
		return 0
	}
	return min(p.until, p.since+int64(pressureMax))
}

// probeBudget is how many more transports may start a probe in one control tick.
type probeBudget struct{ slots int }

func (b *probeBudget) take() bool {
	if b.slots <= 0 {
		return false
	}
	b.slots--
	return true
}
