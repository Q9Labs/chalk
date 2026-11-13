package recorderworker

import (
	"context"
	"errors"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
)

type captureTimeoutError struct{}

func (captureTimeoutError) Error() string { return "timeout" }

func (captureTimeoutError) Timeout() bool { return true }

func (captureTimeoutError) Temporary() bool { return true }

type captureTestTrack struct {
	capture  captureplane.PulledCaptureTrack
	codec    string
	packets  []*rtp.Packet
	readAt   int
	readErr  error
	deadline time.Time
}

type captureBlockingTestTrack struct {
	started chan struct{}
	release chan struct{}
}

func (*captureBlockingTestTrack) CaptureTrack() captureplane.PulledCaptureTrack {
	return captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{Kind: captureplane.TrackKindAudio}, MID: "0"}
}

func (*captureBlockingTestTrack) MID() captureplane.ProviderReference { return "0" }

func (*captureBlockingTestTrack) Codec() string { return "opus" }

func (*captureBlockingTestTrack) RID() string { return "" }

func (t *captureBlockingTestTrack) ReadRTP() (*rtp.Packet, interceptor.Attributes, error) {
	close(t.started)
	<-t.release
	return nil, nil, errors.New("reader released")
}

func (*captureBlockingTestTrack) SetReadDeadline(time.Time) error { return nil }

func (t *captureTestTrack) CaptureTrack() captureplane.PulledCaptureTrack { return t.capture }

func (t *captureTestTrack) MID() captureplane.ProviderReference { return t.capture.MID }

func (t *captureTestTrack) Codec() string { return t.codec }

func (t *captureTestTrack) RID() string { return "" }

func (t *captureTestTrack) ReadRTP() (*rtp.Packet, interceptor.Attributes, error) {
	if t.readAt < len(t.packets) {
		packet := t.packets[t.readAt]
		t.readAt++
		return packet, nil, nil
	}
	return nil, nil, t.readErr
}

func (t *captureTestTrack) SetReadDeadline(deadline time.Time) error {
	t.deadline = deadline
	return nil
}

type captureTestPeer struct {
	err                error
	epoch              captureplane.CaptureEpoch
	order              *[]string
	keyFrameRequests   []captureplane.ProviderReference
	keyFrameRequestErr error
}

func (p *captureTestPeer) RegisterTracks([]captureplane.PulledCaptureTrack) error { return nil }

func (p *captureTestPeer) CreateLocalOffer(context.Context, ...captureplane.ProviderReference) (captureplane.Negotiation, error) {
	return captureplane.Negotiation{}, nil
}

func (p *captureTestPeer) AnswerRemoteOffer(context.Context, captureplane.Negotiation) (captureplane.Description, error) {
	return captureplane.Description{}, nil
}

func (p *captureTestPeer) ApplyRemoteAnswer(context.Context, captureplane.Negotiation) error {
	return nil
}

func (p *captureTestPeer) Epoch() captureplane.CaptureEpoch {
	if p.epoch == 0 {
		return 1
	}
	return p.epoch
}

func (p *captureTestPeer) WaitForTrack(context.Context, captureplane.ProviderReference) (CaptureMediaTrack, error) {
	return nil, errors.New("not implemented")
}

func (p *captureTestPeer) RequestKeyFrame(mid captureplane.ProviderReference) error {
	p.keyFrameRequests = append(p.keyFrameRequests, mid)
	return p.keyFrameRequestErr
}

func (p *captureTestPeer) Error() error { return p.err }

func (p *captureTestPeer) Close() error {
	if p.order != nil {
		*p.order = append(*p.order, "peer")
	}
	return nil
}

type captureTestSignaling struct{}

func (*captureTestSignaling) Execute(context.Context, capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
	return capturesignaling.Execution{}, errors.New("capture test signaling is not called")
}

type captureTestPlans struct{}

func (*captureTestPlans) WaitForPlan(context.Context, captureplan.WaitInput) (captureplan.Plan, error) {
	return captureplan.Plan{}, errors.New("capture test plan source is not called")
}

type captureTestPlanSource struct{ plan captureplan.Plan }

func (p *captureTestPlanSource) WaitForPlan(context.Context, captureplan.WaitInput) (captureplan.Plan, error) {
	return p.plan, nil
}

type captureTestCoordinator struct {
	order  *[]string
	forces []bool
}

func (c *captureTestCoordinator) Bootstrap(context.Context, captureplan.Plan) (recordercapture.Snapshot, error) {
	return recordercapture.Snapshot{PlanRevision: 1}, nil
}

func (c *captureTestCoordinator) Reconcile(context.Context, captureplan.Plan) (recordercapture.Snapshot, error) {
	return recordercapture.Snapshot{PlanRevision: 1}, nil
}

func (c *captureTestCoordinator) Snapshot() (recordercapture.Snapshot, error) {
	return recordercapture.Snapshot{PlanRevision: 1}, nil
}

func (c *captureTestCoordinator) Close(_ context.Context, force bool) error {
	if c.order != nil {
		*c.order = append(*c.order, "provider")
	}
	c.forces = append(c.forces, force)
	return nil
}

func (c *captureTestCoordinator) RenewLease(capturesignaling.WorkerLease) error { return nil }
