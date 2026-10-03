package recorderworker

import (
	"crypto/sha256"
	"encoding/binary"

	"github.com/pion/rtp"
)

// E26 replayed older camera payloads with fresh sequence numbers. Keep a
// bounded history of distinct media packets across bundle rotations; repeats
// must not evict the originals. E26's longest replay span fits in this window.
const captureVideoReplayPackets = 8192

type captureVideoReplayWindow struct {
	ssrc   uint32
	latest uint32
	seen   map[[sha256.Size]byte]struct{}
	order  [][sha256.Size]byte
	next   int
}

func (w *captureVideoReplayWindow) accept(packet *rtp.Packet, inOrder bool) bool {
	if w.seen == nil || w.ssrc != packet.SSRC {
		*w = captureVideoReplayWindow{
			ssrc: packet.SSRC, latest: packet.Timestamp,
			seen:  make(map[[sha256.Size]byte]struct{}, captureVideoReplayPackets),
			order: make([][sha256.Size]byte, 0, captureVideoReplayPackets),
		}
	}
	// RTP timestamps wrap. Equal fragments in the current frame can be
	// legitimate. A late original sequence can also be a first-time repair of
	// an equal fragment. Only a fresh sequence can identify an older-frame replay.
	older := int32(packet.Timestamp-w.latest) < 0
	if !older {
		w.latest = packet.Timestamp
	}
	var header [6]byte
	binary.BigEndian.PutUint32(header[:4], packet.Timestamp)
	header[4] = packet.PayloadType
	if packet.Marker {
		header[5] = 1
	}
	hash := sha256.New()
	hash.Write(header[:])
	hash.Write(packet.Payload)
	var digest [sha256.Size]byte
	hash.Sum(digest[:0])
	if _, exists := w.seen[digest]; exists {
		return !older || !inOrder
	}
	if len(w.order) < captureVideoReplayPackets {
		w.order = append(w.order, digest)
	} else {
		delete(w.seen, w.order[w.next])
		w.order[w.next] = digest
		w.next = (w.next + 1) % captureVideoReplayPackets
	}
	w.seen[digest] = struct{}{}
	return true
}
