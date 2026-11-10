package media

import (
	"errors"
	"strings"
	"testing"
)

// paddedOffer is a session description of exactly size bytes whose only content is padding.
func paddedOffer(size int) string {
	const head = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n"
	const line = "a=padding:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\n"
	body := head + strings.Repeat(line, (size-len(head))/len(line))
	return body + strings.Repeat("\r", size-len(body))
}

func TestParseOfferAcceptsAnOfferUpToTheCapAndRefusesOneOverIt(t *testing.T) {
	for _, size := range []int{maxSDPBytes / 4, 100 << 10, maxSDPBytes} {
		if _, err := parseOffer(paddedOffer(size)); err != nil {
			t.Fatalf("offer of %d bytes: %v, want accepted", size, err)
		}
	}
	if _, err := parseOffer(paddedOffer(maxSDPBytes + 1)); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("offer over the cap: %v, want invalid request", err)
	}
}
