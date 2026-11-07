package media

// vp8Descriptor is what the forwarder reads from, and rewrites in, an RTP VP8
// payload descriptor (RFC 7741 section 4.2). Offsets index the RTP payload.
type vp8Descriptor struct {
	// frameStart is the first packet of a frame: S set and partition index 0.
	frameStart bool
	// keyframe is a frameStart packet whose VP8 payload header marks a key frame.
	keyframe bool

	pictureIDBits   uint8 // 0 when absent, else 7 or 15
	pictureID       uint16
	pictureIDOffset uint8

	hasTL0    bool
	tl0       uint8
	tl0Offset uint8

	hasKeyIdx    bool
	keyIdx       uint8 // 5 bits
	keyIdxOffset uint8
}

const (
	vp8ExtendedBit = 0x80
	vp8StartBit    = 0x10
	vp8PIDMask     = 0x07
	vp8PictureBit  = 0x80
	vp8TL0Bit      = 0x40
	vp8TIDBit      = 0x20
	vp8KeyIdxBit   = 0x10
	vp8LongIDBit   = 0x80
	vp8KeyIdxMask  = 0x1f
	vp8InterFrame  = 0x01 // the P bit of the VP8 payload header; clear on a key frame
)

// parseVP8 reads the descriptor at the start of payload. It reports false for a
// payload too short to hold the descriptor it announces.
func parseVP8(payload []byte) (vp8Descriptor, bool) {
	var d vp8Descriptor
	if len(payload) < 1 {
		return d, false
	}
	first := payload[0]
	index := 1
	if first&vp8ExtendedBit != 0 {
		if len(payload) < 2 {
			return d, false
		}
		extension := payload[1]
		index = 2
		if extension&vp8PictureBit != 0 {
			if len(payload) <= index {
				return d, false
			}
			d.pictureIDOffset = uint8(index)
			if payload[index]&vp8LongIDBit != 0 {
				if len(payload) <= index+1 {
					return d, false
				}
				d.pictureIDBits = 15
				d.pictureID = uint16(payload[index]&0x7f)<<8 | uint16(payload[index+1])
				index += 2
			} else {
				d.pictureIDBits = 7
				d.pictureID = uint16(payload[index])
				index++
			}
		}
		if extension&vp8TL0Bit != 0 {
			if len(payload) <= index {
				return d, false
			}
			d.hasTL0, d.tl0, d.tl0Offset = true, payload[index], uint8(index)
			index++
		}
		if extension&(vp8TIDBit|vp8KeyIdxBit) != 0 {
			if len(payload) <= index {
				return d, false
			}
			if extension&vp8KeyIdxBit != 0 {
				d.hasKeyIdx, d.keyIdx, d.keyIdxOffset = true, payload[index]&vp8KeyIdxMask, uint8(index)
			}
			index++
		}
	}
	d.frameStart = first&vp8StartBit != 0 && first&vp8PIDMask == 0
	if d.frameStart {
		if len(payload) <= index {
			return d, false
		}
		d.keyframe = payload[index]&vp8InterFrame == 0
	}
	return d, true
}

// vp8Rewrite holds the descriptor values one subscriber sends.
type vp8Rewrite struct {
	pictureID uint16
	tl0       uint8
	keyIdx    uint8
}

// differs reports whether writing r changes the descriptor's bytes.
func (r vp8Rewrite) differs(d *vp8Descriptor) bool {
	return (d.pictureIDBits != 0 && r.pictureID != d.pictureID) ||
		(d.hasTL0 && r.tl0 != d.tl0) ||
		(d.hasKeyIdx && r.keyIdx != d.keyIdx)
}

// apply writes r into a copy of the payload. The descriptor keeps its layout, so
// a 7-bit picture ID stays 7 bits.
func (r vp8Rewrite) apply(d *vp8Descriptor, payload []byte) {
	switch d.pictureIDBits {
	case 15:
		payload[d.pictureIDOffset] = vp8LongIDBit | byte(r.pictureID>>8)&0x7f
		payload[d.pictureIDOffset+1] = byte(r.pictureID)
	case 7:
		payload[d.pictureIDOffset] = byte(r.pictureID) & 0x7f
	}
	if d.hasTL0 {
		payload[d.tl0Offset] = r.tl0
	}
	if d.hasKeyIdx {
		payload[d.keyIdxOffset] = payload[d.keyIdxOffset]&^vp8KeyIdxMask | r.keyIdx&vp8KeyIdxMask
	}
}

// pictureIDMask is the modulus of a picture ID with that many bits.
func pictureIDMask(bits uint8) uint16 {
	if bits == 7 {
		return 0x7f
	}
	return 0x7fff
}
