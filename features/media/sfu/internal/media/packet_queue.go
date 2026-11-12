package media

import "sync"

// queuedPacket is a packet waiting for the pacer, with its own copy of the payload.
type queuedPacket struct {
	packet egressPacket
	buffer *[maxPayloadBytes + 2]byte
	queued int64
}

type packetQueue struct {
	items []queuedPacket
	head  int
}

var queueBuffers = sync.Pool{New: func() any { return new([maxPayloadBytes + 2]byte) }}

func (q *packetQueue) empty() bool { return q.head == len(q.items) }

// push appends one item. Before the slice would grow it drops the popped
// prefix, so a queue that never empties keeps only what it holds.
func (q *packetQueue) push(item queuedPacket) {
	if q.head > 0 && len(q.items) == cap(q.items) {
		n := copy(q.items, q.items[q.head:])
		clear(q.items[n:])
		q.items, q.head = q.items[:n], 0
	}
	q.items = append(q.items, item)
}

func (q *packetQueue) pop() queuedPacket {
	item := q.items[q.head]
	q.items[q.head] = queuedPacket{}
	q.head++
	if q.head == len(q.items) {
		q.items, q.head = q.items[:0], 0
	}
	return item
}
