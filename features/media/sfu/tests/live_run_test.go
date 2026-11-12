package tests

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// liveRun is one run of classes on a node: the classes that joined, the share and grant loops
// that keep them going, and the samples taken while they are held.
type liveRun struct {
	t       *testing.T
	svc     *service
	load    liveLoad
	id      int64
	sharing context.Context // ends the run's background loops

	mu      sync.Mutex
	classes []*liveClass
	indexes map[*liveClass]int
	cpu     hostCPU
}

// runLiveClasses holds the load's classes on the node behind svc for the load's hold, then judges
// the run (judgeSoak).
func runLiveClasses(t *testing.T, svc *service, load liveLoad) {
	t.Helper()
	out := openSampleLog(t, load.samples)
	// The node keeps operation IDs for idempotency, so each run needs its own.
	operations.Store(time.Now().UnixNano())
	sharing, stopSharing := context.WithCancel(context.Background())
	t.Cleanup(stopSharing)
	r := &liveRun{t: t, svc: svc, load: load, id: time.Now().UnixNano(), sharing: sharing, indexes: map[*liveClass]int{}}
	go r.renewGrants()
	r.joinAll()
	r.cpu = readHostCPU()
	// The baseline comes before the first wait, so drops during that wait count.
	first := takeSample(svc, r.snapshot(), &r.cpu)
	first.Elapsed = "0s"
	started := time.Now()
	samples := r.hold(first, started, out)
	r.logStalls()
	if load.step > 0 {
		return
	}
	// A last sample at the end of the window, so a track that went quiet after the previous
	// one still counts.
	last := takeSample(svc, r.snapshot(), &r.cpu)
	evidence := soakEvidence{load: load, started: started, ended: time.Now(), first: first, last: last, samples: samples}
	if load.nodeCPU != "" {
		evidence.nodeCPU, evidence.nodeCPUErr = readNodeCPU(load.nodeCPU, evidence.started, evidence.ended)
	} else if load.hold >= fullRunHold {
		evidence.nodeCPUErr = fmt.Errorf("not set")
	}
	result := judgeSoak(evidence)
	if load.result != "" {
		writeSoakResult(t, load.result, result)
	}
	for _, failure := range result.Failures {
		t.Error(failure)
	}
}

// openSampleLog opens the file one JSON sample per line is appended to, or returns nil without one.
func openSampleLog(t *testing.T, path string) *json.Encoder {
	if path == "" {
		return nil
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	return json.NewEncoder(file)
}

// snapshot copies the classes so a sample can iterate them outside the lock.
func (r *liveRun) snapshot() []*liveClass {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.classes)
}

// renewGrants has the API renew every standing grant every 5 s; without it a source's 15-second
// lease lapses and the node stops forwarding it.
func (r *liveRun) renewGrants() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.sharing.Done():
			return
		case <-ticker.C:
		}
		for _, class := range r.snapshot() {
			class.renewGrants(r.svc)
		}
	}
}

// joinAll joins the load's classes. The guard may close admission for a few seconds while classes
// join, so a fixed run retries a refused class as a client would, and logs each refusal.
func (r *liveRun) joinAll() {
	for range r.load.classes {
		for attempt := 1; ; attempt++ {
			refused := r.join()
			if refused == "" {
				break
			}
			if attempt == 6 {
				r.t.Fatalf("the node refused class %d %d times: %s", r.load.classOffset+len(r.snapshot()), attempt, refused)
			}
			r.t.Logf("refused, retrying in 10 s: %s", refused)
			time.Sleep(10 * time.Second)
		}
	}
}

// join adds one class and waits for its media to flow. It returns why the node refused the class
// or the class never flowed, or "" when the class is in the run.
func (r *liveRun) join() string {
	index, joining := r.load.classOffset+len(r.snapshot()), time.Now()
	defer func() {
		r.t.Logf("class %d joined at %s in %v", index, joining.UTC().Format(time.TimeOnly), time.Since(joining).Round(time.Millisecond))
	}()
	class, refused := joinClass(r.t, r.svc, r.load, r.id, index)
	if refused != "" {
		return refused
	}
	if r.load.shareOn() > 0 {
		class.shareStart.Store(time.Now().UnixNano())
	}
	var classCtx context.Context
	classCtx, class.stop = context.WithCancel(r.sharing)
	go class.shareInStretches(classCtx, r.load, time.Duration(index)*r.load.sharePeriod/5)
	r.mu.Lock()
	r.classes = append(r.classes, class)
	r.indexes[class] = index
	r.mu.Unlock()
	for deadline := time.Now().Add(30 * time.Second); !class.flowing(); time.Sleep(100 * time.Millisecond) {
		if time.Now().After(deadline) {
			return r.drop(class, index)
		}
	}
	return ""
}

// drop removes a class that never flowed. The retry starts a class of its own, so this one must
// not stay in the run.
func (r *liveRun) drop(class *liveClass, index int) string {
	why := fmt.Sprintf("class %d: a Participant missed a microphone or screen for 30 s: %s", index, class.describe(r.svc))
	class.shutdown()
	r.mu.Lock()
	r.classes = without(r.classes, class)
	r.mu.Unlock()
	_, _ = r.svc.call(r.t, "/v1/episodes/end", protocol.EndEpisodeRequest{TenantID: liveTenant, EpisodeID: class.episode}, nil)
	return why
}

// hold samples the run every load.every until the hold ends or, in a step-up run, a class is
// refused or a quality signal breaks. It returns every sample, first included.
func (r *liveRun) hold(first liveSample, started time.Time, out *json.Encoder) []liveSample {
	previous, samples := first, []liveSample{first}
	nextStep := started.Add(r.load.step)
	ticker := time.NewTicker(r.load.every)
	defer ticker.Stop()
	for time.Since(started) < r.load.hold {
		<-ticker.C
		live := r.snapshot()
		sample := takeSample(r.svc, live, &r.cpu)
		sample.Elapsed = time.Since(started).Round(time.Second).String()
		if r.load.step > 0 {
			sample.Broke = qualityBreak(previous, sample)
		}
		if r.load.step > 0 && sample.Broke == "" && !time.Now().Before(nextStep) {
			sample.Refused = r.join()
			nextStep = nextStep.Add(r.load.step)
		}
		if out != nil {
			if err := out.Encode(sample); err != nil {
				r.t.Fatal(err)
			}
		}
		r.t.Log(sample.line())
		samples = append(samples, sample)
		previous = sample
		if sample.Broke != "" || sample.Refused != "" {
			r.t.Logf("step-up stopped at %d classes: %s%s", len(live), sample.Broke, sample.Refused)
			break
		}
	}
	return samples
}

// logStalls logs every track that stalled, and the first class at the end of the run.
func (r *liveRun) logStalls() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.t.Logf("first class at the end:%s", r.classes[0].describe(r.svc))
	for _, class := range r.classes {
		for index, receiver := range class.receivers {
			receiver.mu.Lock()
			for key, track := range receiver.tracks {
				if stalls, longest := track.stallsAt(time.Now(), class.sharingSince()); stalls > 0 {
					r.t.Logf("class %d stalled: %s %s %s: %d stalls, longest %v ending %s, frames %v", r.indexes[class], class.people[index].name, key, track.kind, stalls, longest, track.longestAt.UTC().Format(time.RFC3339Nano), track.frames)
				}
			}
			receiver.mu.Unlock()
		}
	}
}

// without returns classes minus one. It copies, because the renewal loop and the samples
// iterate the old slice outside the lock and DeleteFunc would rewrite it under them.
func without(classes []*liveClass, gone *liveClass) []*liveClass {
	return slices.DeleteFunc(slices.Clone(classes), func(c *liveClass) bool { return c == gone })
}
