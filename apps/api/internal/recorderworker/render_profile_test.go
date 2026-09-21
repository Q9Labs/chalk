package recorderworker

import (
	"errors"
	"testing"
)

func TestRenderAttemptObserverReceivesStageAndFrameMeasurements(t *testing.T) {
	observer := &renderAttemptObserverForTest{}
	attempt := &ProductionRenderAttempt{config: ProductionRenderAttemptConfig{Observer: observer}}
	want := errors.New("profile failure")
	if err := attempt.measure(RenderAttemptStageDownloadCapture, func() error { return want }); !errors.Is(err, want) {
		t.Fatalf("measure error = %v", err)
	}
	attempt.observeFrameEncoding(FrameEncodeResult{EncodeDuration: 7}, true)

	if len(observer.stages) != 1 || observer.stages[0].Stage != RenderAttemptStageDownloadCapture || observer.stages[0].Succeeded || observer.stages[0].WallDuration < 0 {
		t.Fatalf("stage measurements = %#v", observer.stages)
	}
	if len(observer.frames) != 1 || !observer.frames[0].Succeeded || observer.frames[0].Result.EncodeDuration != 7 {
		t.Fatalf("frame measurements = %#v", observer.frames)
	}
}

type renderAttemptObserverForTest struct {
	stages []RenderAttemptStageMeasurement
	frames []RenderFrameEncodingMeasurement
}

func (observer *renderAttemptObserverForTest) ObserveRenderAttemptStage(measurement RenderAttemptStageMeasurement) {
	observer.stages = append(observer.stages, measurement)
}

func (observer *renderAttemptObserverForTest) ObserveRenderFrameEncoding(measurement RenderFrameEncodingMeasurement) {
	observer.frames = append(observer.frames, measurement)
}
