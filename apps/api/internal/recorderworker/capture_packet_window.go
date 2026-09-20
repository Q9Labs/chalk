package recorderworker

// Retain a bounded reorder window across bundle rotations. Retransmissions
// must not drag a later bundle's media start back to an already-recorded frame.
type capturePacketWindow struct {
	sequence rtpSequenceExtender
	ssrc     uint32
	seen     [1024]uint64
}

func (w *capturePacketWindow) accept(ssrc uint32, sequence uint16) bool {
	if w.ssrc != ssrc {
		*w = capturePacketWindow{ssrc: ssrc}
	}
	extended := w.sequence.Extend(sequence)
	if w.sequence.highest-extended >= uint64(len(w.seen)) {
		return false
	}
	slot := extended % uint64(len(w.seen))
	// Store sequence+1 so a zero-initialized window can accept sequence zero.
	if w.seen[slot] == extended+1 {
		return false
	}
	w.seen[slot] = extended + 1
	return true
}
