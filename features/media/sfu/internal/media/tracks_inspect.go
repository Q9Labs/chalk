package media

import (
	"slices"
	"strings"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// inspectLayers lists a video publication's ingress layers in RID order; a
// single encoding is one layer with an empty RID.
func (p *publication) inspectLayers(now int64) []protocol.InspectedLayer {
	if !p.video() {
		return nil
	}
	var layers []protocol.InspectedLayer
	for index := range p.layers {
		if layer := p.layers[index].Load(); layer != nil {
			inspected := protocol.InspectedLayer{RID: layer.rid, Active: !p.closed.Load() && !p.held.Load() && p.authority.allows(now, now) && layer.active(now), RepairedPackets: layer.repaired.Load()}
			if layer.nack != nil {
				inspected.RequestedPackets = layer.nack.requested.Load()
			}
			layers = append(layers, inspected)
		}
	}
	slices.SortFunc(layers, func(a, b protocol.InspectedLayer) int { return strings.Compare(a.RID, b.RID) })
	return layers
}
