package recordingdecode

import "github.com/pion/rtp/codecs"

type vp8PictureID struct {
	value uint16
	mask  uint16
}

func vp8PictureIDFromPayload(descriptor codecs.VP8Packet, payload []byte) vp8PictureID {
	if descriptor.I == 0 {
		return vp8PictureID{}
	}
	// Unmarshal has already checked the descriptor. PictureID follows the
	// mandatory byte and extension flags, before the other optional fields.
	mask := uint16(0x7f)
	if payload[2]&0x80 != 0 {
		mask = 0x7fff
	}
	return vp8PictureID{value: descriptor.PictureID, mask: mask}
}

func (id vp8PictureID) follows(previous vp8PictureID) bool {
	return id.mask != 0 && id.mask == previous.mask && (id.value-previous.value)&id.mask == 1
}
