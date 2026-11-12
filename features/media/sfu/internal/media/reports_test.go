package media

import (
	"testing"
	"time"
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
	r.onLoss(0, now+int64(2*time.Second))
	if r.ceiling != low*increasePerSec {
		t.Fatalf("ceiling %v after a clean report, want %v", r.ceiling, low*increasePerSec)
	}
	for step := range 100 {
		r.onLoss(0, now+int64(time.Duration(3+step)*time.Second))
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

func TestReportEstimatorFollowsREMBOverLoss(t *testing.T) {
	r := newReportEstimator()
	now := int64(10 * time.Second)
	r.onREMB(800_000, now)
	r.onLoss(0, now+int64(2*time.Second))
	r.onLoss(0.5, now+int64(3*time.Second))
	if r.ceiling != 800_000 {
		t.Fatalf("ceiling %v while a REMB stands, want 800000", r.ceiling)
	}
	r.onLoss(0, now+int64(rembFresh)+int64(time.Second))
	if r.ceiling != 800_000*increasePerSec {
		t.Fatalf("ceiling %v once the REMB is stale, want loss reports to steer again", r.ceiling)
	}
	r.onREMB(1, now)
	if r.ceiling != minEstimate {
		t.Fatalf("ceiling %v for a tiny REMB, want the floor", r.ceiling)
	}
}
