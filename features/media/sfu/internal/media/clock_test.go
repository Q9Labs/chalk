package media

import "time"

// nextTick returns a clock reading later than every packet already sent. A coarse clock (Windows)
// gives packets sent in the same few milliseconds one timestamp, so a lease granted without
// waiting would also cover the packets sent before it.
func nextTick() int64 {
	before := monotonic()
	for monotonic() == before {
		time.Sleep(time.Millisecond)
	}
	return monotonic()
}
