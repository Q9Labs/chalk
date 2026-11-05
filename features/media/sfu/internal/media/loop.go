package media

import "time"

const (
	// allocationInterval is how often every subscriber's layers are reallocated
	// from its bandwidth estimate and its Episode's packet ceiling.
	allocationInterval = 100 * time.Millisecond
	// guardInterval is how often the host-health guard samples.
	guardInterval = time.Second
)

// run is the node's control loop: it allocates layers and samples host health
// until the node closes.
func (n *Node) run() {
	allocate := time.NewTicker(allocationInterval)
	defer allocate.Stop()
	health := time.NewTicker(guardInterval)
	defer health.Stop()
	for {
		select {
		case <-n.done:
			return
		case <-allocate.C:
			n.allocate()
		case <-health.C:
			n.guard.tick()
		}
	}
}
