package media

import (
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// attach binds one incoming stream as a layer. It returns nil when the
// publication is closed, already has the RID, or has no free layer; the caller
// then drains the stream. The first layer starts the publication's monitor.
// audioLevelID is the microphone's negotiated audio level extension, or 0.
func (p *publication) attach(remote *webrtc.TrackRemote, audioLevelID uint8) (*ingressLayer, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed.Load() {
		return nil, false
	}
	free := -1
	for index := range p.layers {
		existing := p.layers[index].Load()
		if existing == nil {
			if free < 0 {
				free = index
			}
			continue
		}
		if existing.rid == remote.RID() {
			return nil, false
		}
	}
	if free < 0 {
		return nil, false
	}
	layer := newIngressLayer(free, remote, p.source, p.session.node.cfg.Memory)
	layer.audioLevelID = audioLevelID
	if layer.nack != nil {
		pc, ssrc := p.session.pc, layer.ssrc
		layer.nack.send = func(seqs []uint16) { _ = pc.WriteRTCP(nackPacket(ssrc, seqs)) }
		layer.nack.gaveUp = func() { p.requestKeyframe(layer.index) }
	}
	p.layers[free].Store(layer)
	startMonitor := !p.monitoring
	p.monitoring = true
	return layer, startMonitor
}

// read forwards one layer until its stream ends. After the publication closes
// it keeps reading and discards, so Pion's buffer for the stream stays empty.
func (p *publication) read(layer *ingressLayer) {
	buffer := make([]byte, maxPayloadBytes)
	writer := &packetWriter{}
	var header rtp.Header
	for {
		n, attributes, err := layer.remote.Read(buffer)
		if err != nil {
			return
		}
		if !p.closed.Load() {
			repaired := attributes.Get(webrtc.AttributeRtxSequenceNumber) != nil
			p.forward(layer, buffer[:n], repaired, &header, writer)
		}
	}
}

// forward keeps one packet of layer in its history and hands it to every
// subscription. repaired marks a packet that arrived as an RTX repair. The
// caller owns header and writer, so it allocates nothing.
func (p *publication) forward(layer *ingressLayer, raw []byte, repaired bool, header *rtp.Header, writer *packetWriter) {
	layer.meter.add(len(raw))
	if p.held.Load() {
		return
	}
	packet, ok := parseRTP(header, raw, p.video())
	if !ok {
		return
	}
	if repaired {
		layer.repaired.Add(1)
	}
	newest := layer.newest()
	packet.extSeq = layer.extend(header.SequenceNumber)
	packet.arrival = monotonic()
	if layer.nack != nil {
		layer.nack.observe(packet.extSeq, newest, packet.arrival)
	}
	if layer.audioLevelID != 0 {
		p.readAudioLevel(layer, header, &packet)
	}
	if history := layer.history.Load(); history != nil {
		if !history.store(&packet) {
			return
		}
	}
	resumed := !layer.active(packet.arrival)
	if resumed {
		// The monitor may have missed the gap, so end the live segments while
		// the layer still reads idle; the next reselect waits for a keyframe.
		p.reselect()
	}
	layer.lastRTP.Store(packet.arrival)
	if resumed {
		p.reselect()
	}
	subscribers := p.subscribers.Load()
	if subscribers == nil {
		return
	}
	for _, subscription := range *subscribers {
		subscription.deliver(layer, &packet, writer)
	}
}

// voicedLevel is the quietest RFC 6464 level, in -dBov, that counts as speech.
// Room noise sits near 70 and silence at 127.
const voicedLevel = 50

// readAudioLevel copies a microphone packet's audio level for subscribers and
// records the publisher as speaking when it is loud enough.
func (p *publication) readAudioLevel(layer *ingressLayer, header *rtp.Header, packet *rtpPacket) {
	extension := header.GetExtension(layer.audioLevelID)
	if len(extension) < 1 {
		return
	}
	packet.audioLevel, packet.hasAudioLevel = extension[0], true
	if extension[0]&0x7f <= voicedLevel {
		p.session.lastVoiced.Store(packet.arrival)
	}
}

// parseRTP reads the header into header, which the caller reuses so the
// steady state allocates nothing, and describes the payload.
func parseRTP(header *rtp.Header, raw []byte, video bool) (rtpPacket, bool) {
	headerSize, err := header.Unmarshal(raw)
	if err != nil {
		return rtpPacket{}, false
	}
	payload := raw[headerSize:]
	var padding byte
	if header.Padding {
		if len(payload) == 0 || int(payload[len(payload)-1]) > len(payload) || payload[len(payload)-1] == 0 {
			return rtpPacket{}, false
		}
		padding = payload[len(payload)-1]
		payload = payload[:len(payload)-int(padding)]
	}
	packet := rtpPacket{timestamp: header.Timestamp, marker: header.Marker, paddingSize: padding, payload: payload}
	if video && len(payload) > 0 {
		packet.vp8, packet.hasVP8 = parseVP8(payload)
	}
	return packet, true
}

// drain reads a stream nobody forwards until it ends, so Pion never buffers it.
func drain(remote *webrtc.TrackRemote) {
	buffer := make([]byte, maxPayloadBytes)
	for {
		if _, _, err := remote.Read(buffer); err != nil {
			return
		}
	}
}
