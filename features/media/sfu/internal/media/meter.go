package media

import (
	"math"
	"sync/atomic"
	"time"
)

// meterSlots is how many control-loop samples a meter's window holds: one
// second at the allocation interval.
const meterSlots = int(time.Second / allocationInterval)

// rateMeter measures one packet stream's packets/s and bits/s over the last
// second. Packet loops add without locking; the node's control loop samples,
// and anyone may read the rates.
type rateMeter struct {
	packets atomic.Uint64
	bytes   atomic.Uint64

	// Owned by the control loop: the counts at each of the last samples.
	ring  [meterSlots + 1]meterReading
	next  int
	taken int

	pps atomic.Uint64 // float64 bits
	bps atomic.Uint64 // float64 bits
}

type meterReading struct {
	at             int64
	packets, bytes uint64
}

func (m *rateMeter) add(bytes int) {
	m.packets.Add(1)
	m.bytes.Add(uint64(bytes))
}

// sample records the counts now and sets the rates over the window it covers.
func (m *rateMeter) sample(now int64) {
	reading := meterReading{at: now, packets: m.packets.Load(), bytes: m.bytes.Load()}
	m.ring[m.next] = reading
	m.next = (m.next + 1) % len(m.ring)
	m.taken = min(m.taken+1, len(m.ring))
	if m.taken < 2 {
		return
	}
	oldest := m.ring[(m.next-m.taken+len(m.ring))%len(m.ring)]
	seconds := time.Duration(reading.at - oldest.at).Seconds()
	if seconds <= 0 {
		return
	}
	m.pps.Store(math.Float64bits(float64(reading.packets-oldest.packets) / seconds))
	m.bps.Store(math.Float64bits(float64(reading.bytes-oldest.bytes) * 8 / seconds))
}

// rates are the packets/s and bits/s over the last second.
func (m *rateMeter) rates() (pps, bps float64) {
	return math.Float64frombits(m.pps.Load()), math.Float64frombits(m.bps.Load())
}
