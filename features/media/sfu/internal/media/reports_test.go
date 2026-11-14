package media

import (
	"os"
	"slices"
	"testing"
	"time"

	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

func TestReportEstimatorStepsDownOnHeavyLossAndUpOnLight(t *testing.T) {
	r := newReportEstimator()
	now := int64(10 * time.Second)
	r.onLoss(0.5, now)
	if want := reportStart * 0.75; r.ceiling != want {
		t.Fatalf("ceiling %v after 50%% loss, want %v", r.ceiling, want)
	}
	if !r.lossy(now+int64(time.Second)) || r.lossy(now+int64(3*time.Second)) {
		t.Fatal("heavy loss should count as proof of a full path for two seconds")
	}
	r.onLoss(0.5, now+int64(100*time.Millisecond))
	if r.ceiling != reportStart*0.75 {
		t.Fatalf("a second report within the spacing moved the ceiling to %v", r.ceiling)
	}
	low := r.ceiling
	r.onLoss(0, now+int64(3*time.Second))
	if r.ceiling != low*increasePerSec {
		t.Fatalf("ceiling %v after a clean report, want %v", r.ceiling, low*increasePerSec)
	}
	for step := range 100 {
		r.onLoss(0, now+int64(time.Duration(4+step)*time.Second))
	}
	if r.ceiling != reportMax {
		t.Fatalf("ceiling %v after a long clean run, want the cap %v", r.ceiling, float64(reportMax))
	}
	r = newReportEstimator()
	for step := range 100 {
		r.onLoss(0.9, now+int64(time.Duration(step)*time.Second))
	}
	if r.ceiling != minEstimate {
		t.Fatalf("ceiling %v after heavy loss all along, want the floor %v", r.ceiling, float64(minEstimate))
	}
}

// A receiver reports each stream it receives, so a clean audio report can come right before a heavy
// video report. The heavy one still steps the ceiling down, and a clean report does not raise it
// again while that loss stands.
func TestReportEstimatorStepsDownRightAfterACleanReport(t *testing.T) {
	r := newReportEstimator()
	now := int64(10 * time.Second)
	r.onLoss(0, now)
	raised := r.ceiling
	if raised != reportStart*increasePerSec {
		t.Fatalf("ceiling %v after a clean report, want %v", raised, reportStart*increasePerSec)
	}
	r.onLoss(0.5, now+int64(100*time.Millisecond))
	if want := raised * 0.75; r.ceiling != want {
		t.Fatalf("ceiling %v after a heavy report 100 ms behind a clean one, want %v", r.ceiling, want)
	}
	lowered := r.ceiling
	r.onLoss(0, now+int64(1500*time.Millisecond))
	if r.ceiling != lowered {
		t.Fatalf("ceiling %v after a clean report while heavy loss stands, want it held at %v", r.ceiling, lowered)
	}
}

// chromiumOffer is a captured browser offer; tests/browser/capture-offer.mjs regenerates it.
const chromiumOffer = "testdata/chromium-offer.sdp"

// A receiver sends REMB only when the answer negotiates it, so the node's answer to a browser
// offer must carry goog-remb on VP8 in every video section the browser opened to receive in, and
// on no audio section.
func TestAnswerNegotiatesREMBForVideo(t *testing.T) {
	offer, err := os.ReadFile(chromiumOffer)
	if err != nil {
		t.Fatal(err)
	}
	session := newTestNode(t, nil).newTestSession(t, testScope("alice", 1))
	if err := session.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: string(offer)}); err != nil {
		t.Fatal(err)
	}
	answer, err := session.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	var offered, answered sdp.SessionDescription
	if err := offered.Unmarshal(offer); err != nil {
		t.Fatal(err)
	}
	if err := answered.Unmarshal([]byte(answer.SDP)); err != nil {
		t.Fatal(err)
	}
	remb := func(media *sdp.MediaDescription, payloadType string) bool {
		return slices.Contains(media.Attributes, sdp.Attribute{Key: "rtcp-fb", Value: payloadType + " goog-remb"})
	}
	viewing := 0
	for _, section := range answered.MediaDescriptions {
		mid, _ := section.Attribute(sdp.AttrKeyMID)
		if section.MediaName.Media == "audio" && remb(section, "111") {
			t.Errorf("the answer negotiates REMB for audio section %s", mid)
		}
		wanted := offered.MediaDescriptions[slices.IndexFunc(offered.MediaDescriptions, func(m *sdp.MediaDescription) bool {
			offeredMid, _ := m.Attribute(sdp.AttrKeyMID)
			return offeredMid == mid
		})]
		if _, receives := wanted.Attribute(sdp.AttrKeyRecvOnly); section.MediaName.Media != "video" || !receives {
			continue
		}
		viewing++
		if !remb(section, "96") {
			t.Errorf("the answer does not negotiate REMB for VP8 in video section %s, which the browser opened to receive in", mid)
		}
	}
	if viewing == 0 {
		t.Fatal("the offer has no receive-only video section, so the test proves nothing")
	}
}
