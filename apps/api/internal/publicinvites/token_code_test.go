package publicinvites

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"
)

func TestParseInviteCodeAcceptsEveryWrittenForm(t *testing.T) {
	handle := make([]byte, HandleBytes)
	letters := InviteCode(handle)
	words := InviteWordCode(handle)
	grouped := FormatInviteCode(letters)
	for _, test := range []struct {
		name  string
		input string
		want  string
		ok    bool
	}{
		{"letters", letters, letters, true},
		{"grouped letters", grouped, letters, true},
		{"upper case with spaces", "  " + strings.ToUpper(grouped) + " ", letters, true},
		{"words", words, words, true},
		{"words with dots", strings.ReplaceAll(words, "-", "."), words, true},
		{"link", "https://chalkmeet.com/" + grouped, letters, true},
		{"link without scheme", "chalk.q9labs.ai/" + words, words, true},
		{"link on another host", "https://example.com/" + grouped, "", false},
		{"link with query", "https://chalkmeet.com/" + grouped + "?x=1", "", false},
		{"digit in letters", "abcdefghi1", "", false},
		{"wrong group layout", "abcd-efg-hijk", "", false},
		{"unknown word", "zzzzz-" + strings.SplitN(words, "-", 2)[1], "", false},
		{"too few words", strings.Join(strings.Split(words, "-")[:3], "-"), "", false},
		{"empty", "", "", false},
	} {
		got, ok := ParseInviteCode(test.input)
		if got != test.want || ok != test.ok {
			t.Errorf("%s: ParseInviteCode(%q) = %q, %v; want %q, %v", test.name, test.input, got, ok, test.want, test.ok)
		}
	}
}

func TestSignedTokenRoundTripsAndRejectsTampering(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := NewSigner(Keyring{CurrentKeyID: "k1", Signer: private, Verifiers: map[string]ed25519.PublicKey{"k1": public}})
	if err != nil {
		t.Fatal(err)
	}
	issued, raw, err := signer.IssueRandom(3)
	if err != nil {
		t.Fatal(err)
	}
	if raw == "" {
		t.Fatal("IssueRandom returned no token")
	}
	encoded, err := signer.Encode(issued)
	if err != nil {
		t.Fatal(err)
	}
	token, err := signer.Verify(encoded)
	if err != nil || token.Generation != 3 || token.KeyID != "k1" {
		t.Fatalf("Verify = %+v, %v", token, err)
	}
	segments := strings.Split(encoded, ".")
	for name, tampered := range map[string]string{
		"empty":         "",
		"short":         "a.b",
		"signature":     strings.Join(append(segments[:3:3], segments[3][:len(segments[3])-2]+"AA"), "."),
		"unknown key":   strings.Join([]string{segments[0], "k2", segments[2], segments[3]}, "."),
		"non ascii":     encoded + "é",
		"trailing dot":  encoded + ".",
		"swapped parts": strings.Join([]string{segments[0], segments[1], segments[3], segments[2]}, "."),
	} {
		if _, err := signer.Verify(tampered); err == nil {
			t.Errorf("%s: Verify accepted a bad token", name)
		}
	}
}
