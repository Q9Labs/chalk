package chatattachments

import "testing"

func TestKeynoteMIMETypesAllowed(t *testing.T) {
	for _, value := range []string{"application/vnd.apple.keynote", "application/x-iwork-keynote-sffkey", "Application/Vnd.Apple.Keynote; charset=binary"} {
		if _, ok := allowedMIMEType(value); !ok {
			t.Fatalf("%q was rejected", value)
		}
	}
}
