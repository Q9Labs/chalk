package pion

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type bindingContext struct {
	context.Context
	onDone func()
}

func (ctx *bindingContext) Done() <-chan struct{} {
	ctx.onDone()
	return ctx.Context.Done()
}

func TestWaitForTrackConcurrentBinding(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	peer := &Peer{tracks: make(map[string]*MediaTrack), notify: make(chan struct{})}
	want := &MediaTrack{mid: "0"}
	checked := make(chan struct{})
	bound := make(chan struct{})
	defer func() {
		cancel()
		<-bound
	}()
	go func() {
		defer close(bound)
		select {
		case <-checked:
		case <-ctx.Done():
			return
		}
		peer.stateMu.Lock()
		peer.tracks["0"] = want
		peer.signalLocked()
		peer.stateMu.Unlock()
	}()
	// Hand execution to the binder at the context check, before the waiter parks.
	interleaved := &bindingContext{Context: ctx, onDone: sync.OnceFunc(func() {
		close(checked)
		select {
		case <-bound:
		case <-ctx.Done():
		}
	})}
	got, err := peer.WaitForTrack(interleaved, "0")
	if got != want || err != nil {
		_, exists := peer.Track("0")
		t.Fatalf("WaitForTrack = %v, %v; track already bound=%v; want the bound track without another event", got, err, exists)
	}
}

func TestWaitForTrackNilPeer(t *testing.T) {
	var peer *Peer
	if _, err := peer.WaitForTrack(t.Context(), "0"); !errors.Is(err, ErrPeerClosed) {
		t.Fatalf("WaitForTrack on nil peer = %v; want ErrPeerClosed", err)
	}
}
