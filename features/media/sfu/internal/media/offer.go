package media

import (
	"fmt"
	"strings"

	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

// maxSDPBytes bounds an offer before it is parsed. A browser offer with a
// handful of sections is a few kilobytes.
const maxSDPBytes = 64 << 10

// sectionHeadroom lets a session outlive closed publications, and subscriptions the client
// rejected: Pion keeps a stopped transceiver for the life of the peer connection, and only a
// closed subscription's section is reused. A session at the limit refuses new tracks and the
// client replaces the connection.
const sectionHeadroom = 4

// offerSection is what the node needs to know about one media section of a client offer.
type offerSection struct {
	media     string          // "audio" or "video"
	sending   bool            // the client sends in this section
	receiving bool            // the client can receive in this section
	rejected  bool            // port 0: the section is stopped
	codecs    map[string]bool // lower-case encoding names from a=rtpmap
}

// supports reports whether the section offers the codec the node forwards for its media.
func (o offerSection) supports(kind webrtc.RTPCodecType) bool {
	if o.media != kind.String() {
		return false
	}
	if kind == webrtc.RTPCodecTypeAudio {
		return o.codecs["opus"]
	}
	return o.codecs["vp8"]
}

// parseOffer reads the media sections of an offer by MID, before any of it reaches the peer
// connection. Unparseable SDP is a plain error. A parseable offer the node must not apply
// wraps ErrInvalidRequest.
func parseOffer(raw string) (map[string]offerSection, error) {
	if len(raw) > maxSDPBytes {
		return nil, fmt.Errorf("%w: the offer is larger than %d bytes", ErrInvalidRequest, maxSDPBytes)
	}
	var description sdp.SessionDescription
	if err := description.Unmarshal([]byte(raw)); err != nil {
		return nil, fmt.Errorf("parse offer: %w", err)
	}
	sections := make(map[string]offerSection, len(description.MediaDescriptions))
	for _, media := range description.MediaDescriptions {
		kind := media.MediaName.Media
		if kind != "audio" && kind != "video" {
			return nil, fmt.Errorf("%w: the offer has a %q section; only audio and video are supported", ErrInvalidRequest, kind)
		}
		mid, ok := media.Attribute(sdp.AttrKeyMID)
		if !ok || !identifierPattern.MatchString(mid) {
			return nil, fmt.Errorf("%w: every section of the offer needs a valid mid", ErrInvalidRequest)
		}
		if _, repeated := sections[mid]; repeated {
			return nil, fmt.Errorf("%w: the offer repeats mid %q", ErrInvalidRequest, mid)
		}
		sections[mid] = offerSection{media: kind, sending: sendsMedia(media), receiving: receivesMedia(media), rejected: media.MediaName.Port.Value == 0, codecs: encodingNames(media)}
	}
	return sections, nil
}

// sendsMedia reports whether the client sends in the section. A missing direction means sendrecv.
func sendsMedia(media *sdp.MediaDescription) bool {
	if media.MediaName.Port.Value == 0 {
		return false
	}
	for _, attribute := range media.Attributes {
		switch attribute.Key {
		case sdp.AttrKeyRecvOnly, sdp.AttrKeyInactive:
			return false
		}
	}
	return true
}

// receivesMedia reports whether the remote peer can receive media on this section. Pion stops a
// local transceiver when the remote offer marks it inactive; attaching a new sender to that
// stopped transceiver does not revive it, even though its m-line is not rejected.
func receivesMedia(media *sdp.MediaDescription) bool {
	if media.MediaName.Port.Value == 0 {
		return false
	}
	for _, attribute := range media.Attributes {
		switch attribute.Key {
		case sdp.AttrKeySendOnly, sdp.AttrKeyInactive:
			return false
		case sdp.AttrKeyRecvOnly, sdp.AttrKeySendRecv:
			return true
		}
	}
	// No media-level direction means sendrecv.
	return true
}

func encodingNames(media *sdp.MediaDescription) map[string]bool {
	names := map[string]bool{}
	for _, attribute := range media.Attributes {
		if attribute.Key != "rtpmap" {
			continue
		}
		_, encoding, found := strings.Cut(attribute.Value, " ")
		if !found {
			continue
		}
		name, _, _ := strings.Cut(encoding, "/")
		names[strings.ToLower(name)] = true
	}
	return names
}
