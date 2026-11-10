package media

import (
	"fmt"
	"strings"

	"github.com/pion/sdp/v3"
)

// answerableExtensions are the header extensions the node's media engine negotiates (newPeerFactory):
// the ones it registers and the transport-wide sequence number of the feedback it sends. A held
// section answers with these among the client's offered extensions and no others, so it never
// claims an extension a live section would not accept.
var answerableExtensions = map[string]bool{
	sdp.AudioLevelURI:            true,
	sdp.SDESMidURI:               true,
	sdp.SDESRTPStreamIDURI:       true,
	sdp.SDESRepairRTPStreamIDURI: true,
	sdp.TransportCCURI:           true,
}

// Pion stops a local transceiver when a client offer marks its mid inactive, and a stopped
// transceiver cannot send again. The SDK parks every closed receiver as inactive and repeats that in
// each offer it makes, so any offer that arrives while a section is parked would end its reuse.
// holdParked therefore shows Pion each parked section the client marks inactive as recvonly, and
// releaseParked puts the inactive direction back in the answer, so the client sees the answer to
// the offer it made. The parked section stays unsent either way: it has no track.

// holdParked returns the offer with every parked section's inactive direction replaced by recvonly,
// and the mids it changed.
func (s *Session) holdParked(offer string) (string, []string, error) {
	s.mu.Lock()
	parked := make(map[string]bool, len(s.free))
	for _, sec := range s.free {
		parked[sec.transceiver.Mid()] = true
	}
	s.mu.Unlock()
	if len(parked) == 0 {
		return offer, nil, nil
	}
	held, err := retargetSections(offer, parked, sdp.AttrKeyInactive, sdp.AttrKeyRecvOnly)
	if err != nil {
		return "", nil, fmt.Errorf("hold parked sections: %w", err)
	}
	return held.sdp, held.mids, nil
}

// releaseParked marks the held sections of an answer inactive again. Pion leaves the header
// extensions out of an inactive section, and a browser negotiates a bundle's extensions from its
// sections, so it would drop the RID extension and refuse its next simulcast offer. The held sections
// answer with the extensions the client offered on them.
func releaseParked(answer, offer string, held []string) (string, error) {
	if len(held) == 0 {
		return answer, nil
	}
	mids := make(map[string]bool, len(held))
	for _, mid := range held {
		mids[mid] = true
	}
	var offered, answered sdp.SessionDescription
	if err := offered.Unmarshal([]byte(offer)); err != nil {
		return "", fmt.Errorf("release parked sections: %w", err)
	}
	if err := answered.Unmarshal([]byte(answer)); err != nil {
		return "", fmt.Errorf("release parked sections: %w", err)
	}
	extensions := map[string][]sdp.Attribute{}
	for _, media := range offered.MediaDescriptions {
		if mid, ok := media.Attribute(sdp.AttrKeyMID); ok && mids[mid] {
			extensions[mid] = answerable(media.Attributes)
		}
	}
	for _, media := range answered.MediaDescriptions {
		mid, ok := media.Attribute(sdp.AttrKeyMID)
		if !ok || !mids[mid] || media.MediaName.Port.Value == 0 {
			continue
		}
		kept := media.Attributes[:0:0]
		for _, attribute := range media.Attributes {
			if attribute.Key != sdp.AttrKeyExtMap && !isDirection(attribute.Key) {
				kept = append(kept, attribute)
			}
		}
		kept = append(kept, extensions[mid]...)
		media.Attributes = append(kept, sdp.Attribute{Key: sdp.AttrKeyInactive})
	}
	out, err := answered.Marshal()
	if err != nil {
		return "", fmt.Errorf("release parked sections: %w", err)
	}
	return string(out), nil
}

// answerable returns the offered extmap lines for extensions the node negotiates. An extmap value is
// "<id>[/<direction>] <uri> [<attributes>]". The answer keeps the id and what follows the URI but no
// direction: the offerer's direction is not the answerer's.
func answerable(attributes []sdp.Attribute) []sdp.Attribute {
	var found []sdp.Attribute
	for _, attribute := range attributes {
		if attribute.Key != sdp.AttrKeyExtMap {
			continue
		}
		fields := strings.Fields(attribute.Value)
		if len(fields) < 2 || !answerableExtensions[fields[1]] {
			continue
		}
		id, _, _ := strings.Cut(fields[0], "/")
		found = append(found, sdp.Attribute{Key: sdp.AttrKeyExtMap, Value: strings.Join(append([]string{id}, fields[1:]...), " ")})
	}
	return found
}

type retargeted struct {
	sdp  string
	mids []string
}

// retargetSections gives each listed, accepted section that has the direction `from` the direction `to`.
func retargetSections(raw string, mids map[string]bool, from, to string) (retargeted, error) {
	var description sdp.SessionDescription
	if err := description.Unmarshal([]byte(raw)); err != nil {
		return retargeted{}, err
	}
	var changed []string
	for _, media := range description.MediaDescriptions {
		mid, ok := media.Attribute(sdp.AttrKeyMID)
		if !ok || !mids[mid] || media.MediaName.Port.Value == 0 {
			continue
		}
		for index, attribute := range media.Attributes {
			if attribute.Key != from {
				continue
			}
			media.Attributes[index] = sdp.Attribute{Key: to}
			changed = append(changed, mid)
			break
		}
	}
	out, err := description.Marshal()
	if err != nil {
		return retargeted{}, err
	}
	return retargeted{sdp: string(out), mids: changed}, nil
}

func isDirection(key string) bool {
	switch key {
	case sdp.AttrKeySendOnly, sdp.AttrKeyRecvOnly, sdp.AttrKeySendRecv, sdp.AttrKeyInactive:
		return true
	}
	return false
}
