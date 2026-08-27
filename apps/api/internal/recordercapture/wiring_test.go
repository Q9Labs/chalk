package recordercapture_test

import (
	"github.com/q9labs/chalk/apps/api/internal/adapters/pion"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recorderworker"
)

var (
	_ recordercapture.PeerPort      = (*pion.Peer)(nil)
	_ recordercapture.SignalingPort = (*recorderworker.ControlPlaneClient)(nil)
	_ recordercapture.PlanSource    = (*recorderworker.ControlPlaneClient)(nil)
)
