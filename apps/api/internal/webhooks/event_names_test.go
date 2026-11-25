package webhooks

import "testing"

func TestFocusEventsAreSubscribable(t *testing.T) {
	for _, name := range []EventName{EventParticipantFocusChanged, EventFocusCompleted} {
		if !name.Subscribable() || !name.Known() {
			t.Fatalf("%s is not a subscribable webhook event", name)
		}
	}
	if EventParticipantFocusChanged.Resource() != "participant" {
		t.Fatalf("participant.focus_changed resource = %q", EventParticipantFocusChanged.Resource())
	}
	if EventFocusCompleted.Resource() != "focus" {
		t.Fatalf("focus.completed resource = %q", EventFocusCompleted.Resource())
	}
}
