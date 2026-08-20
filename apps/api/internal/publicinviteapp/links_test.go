package publicinviteapp_test

import (
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
)

func TestLinkPortBuildsCanonicalSpaceInviteURL(t *testing.T) {
	port, err := publicinviteapp.NewLinkPort("https://app.chalk.test")
	if err != nil {
		t.Fatal(err)
	}

	got, err := port.SpaceInviteURL("design studio", "cspi1.public-1.payload.signature")
	if err != nil {
		t.Fatal(err)
	}
	const want = "https://app.chalk.test/space/design%20studio#spaceInviteToken=cspi1.public-1.payload.signature"
	if got != want {
		t.Fatalf("invite URL = %q, want %q", got, want)
	}
}

func TestNewLinkPortRejectsNonOriginURLs(t *testing.T) {
	for _, origin := range []string{
		"",
		"https://user:password@app.chalk.test",
		"https://app.chalk.test/space",
		"https://app.chalk.test?space=1",
		"https://app.chalk.test/#invite",
		"https://app.chalk.test#",
		"/app",
	} {
		if _, err := publicinviteapp.NewLinkPort(origin); !errors.Is(err, publicinviteapp.ErrLinkPortUnavailable) {
			t.Fatalf("origin %q error = %v, want link-port unavailable", origin, err)
		}
	}
}

func TestLinkPortRejectsEmptyURLParts(t *testing.T) {
	port, err := publicinviteapp.NewLinkPort("http://localhost:3070")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		slug  string
		token string
	}{
		{slug: "", token: "token"},
		{slug: "space", token: ""},
	} {
		if _, err := port.SpaceInviteURL(test.slug, test.token); !errors.Is(err, publicinviteapp.ErrInvalidLink) {
			t.Fatalf("parts %#v error = %v, want invalid link", test, err)
		}
	}
}
