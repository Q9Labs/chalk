package publicinviteapp

import "testing"

func TestInviteURLs(t *testing.T) {
	links, err := NewLinkPort("https://chalkmeet.com")
	if err != nil {
		t.Fatal(err)
	}
	short, err := links.InviteURL("abcdefghij")
	if err != nil {
		t.Fatal(err)
	}
	if short != "https://chalkmeet.com/abc-defg-hij" {
		t.Fatalf("InviteURL() = %q", short)
	}
	legacy, err := links.LegacyInviteURL("design lab", "cspi1.key.payload.signature")
	if err != nil {
		t.Fatal(err)
	}
	if legacy != "https://chalkmeet.com/space/design%20lab#spaceInviteToken=cspi1.key.payload.signature" {
		t.Fatalf("LegacyInviteURL() = %q", legacy)
	}
}

func TestWordInviteURL(t *testing.T) {
	links, err := NewLinkPort("https://chalkmeet.com")
	if err != nil {
		t.Fatal(err)
	}
	link, err := links.InviteURL("APPLE Tiger.lamp-river")
	if err != nil || link != "https://chalkmeet.com/apple-tiger-lamp-river" {
		t.Fatalf("word link = %q, %v", link, err)
	}
}
