package media

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
)

// testdata/chromium-offer.sdp is a real Chromium offer built the way the SDK builds one: a
// microphone, a simulcast camera, and a receive-only audio and video section for each of seven
// remote guests, six of them closed (inactive). Candidate lines, session id, ICE credentials,
// fingerprint, cname and msid ids are replaced. Regenerate it with tests/browser/capture-offer.mjs.
// At 54,235 bytes it is the size of the 56,665-byte offer production sent, which is why the cap
// matters: each further guest adds about 7 KB.
const chromiumOffer = "testdata/chromium-offer.sdp"

var (
	bundleGroup = regexp.MustCompile(`(?m)^a=group:BUNDLE .*\r$`)
	midLine     = regexp.MustCompile(`(?m)^a=mid:\d+\r$`)
)

// grownOffer adds copies of the fixture's last audio and video sections, with new mids, until the
// offer is as large as it can be below size, then fills the rest of size with bare carriage
// returns so a test can stand exactly on the cap.
func grownOffer(t *testing.T, size int) (offer string, sections int) {
	t.Helper()
	raw, err := os.ReadFile(chromiumOffer)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(string(raw), "\r\nm=")
	for i := 1; i < len(parts); i++ {
		parts[i] = "m=" + strings.TrimSuffix(parts[i], "\r\n") + "\r\n"
	}
	sections = len(parts) - 1
	guest := parts[len(parts)-2:]
	body := string(raw)
	for mid := sections; ; mid += 2 {
		pair := ""
		for i, section := range guest {
			pair += midLine.ReplaceAllString(section, fmt.Sprintf("a=mid:%d\r", mid+i))
		}
		if len(body)+len(pair) > size {
			break
		}
		body += pair
		sections += 2
	}
	mids := make([]string, sections)
	for mid := range mids {
		mids[mid] = fmt.Sprint(mid)
	}
	body = bundleGroup.ReplaceAllString(body, "a=group:BUNDLE "+strings.Join(mids, " ")+"\r")
	return body + strings.Repeat("\r", size-len(body)), sections
}

func TestParseOfferAcceptsTheChromiumOfferAsCapturedAndGrownUpToTheCap(t *testing.T) {
	raw, err := os.ReadFile(chromiumOffer)
	if err != nil {
		t.Fatal(err)
	}
	sections, err := parseOffer(string(raw))
	if err != nil || len(sections) != 16 {
		t.Fatalf("captured offer of %d bytes: %d sections, %v; want 16 sections accepted", len(raw), len(sections), err)
	}
	if len(raw) <= 48<<10 {
		t.Fatalf("captured offer is %d bytes; it must be larger than the 48 KiB proof bar to mean anything", len(raw))
	}
	grown, count := grownOffer(t, maxSDPBytes)
	got, err := parseOffer(grown)
	if err != nil || len(got) != count {
		t.Fatalf("offer of %d bytes: %d of %d sections, %v; want all accepted", len(grown), len(got), count, err)
	}
	if len(grown) != maxSDPBytes {
		t.Fatalf("grown offer is %d bytes, want exactly the cap %d", len(grown), maxSDPBytes)
	}
}

func TestParseOfferRefusesTheChromiumOfferOneByteOverTheCap(t *testing.T) {
	over, _ := grownOffer(t, maxSDPBytes+1)
	if _, err := parseOffer(over); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("offer of %d bytes: %v, want invalid request", len(over), err)
	}
}
