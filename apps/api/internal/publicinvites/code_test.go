package publicinvites

import "testing"

func TestInviteCodeFixedVector(t *testing.T) {
	handle := make([]byte, 32)
	for i := range handle {
		handle[i] = byte(i)
	}
	if got := InviteWordCode(handle); got != "snap-noodle-groom-koala" {
		t.Fatalf("InviteWordCode() = %q", got)
	}
	if got := InviteCode(handle); got != "nhwaprjkrm" {
		t.Fatalf("InviteCode() = %q, want %q", got, "nhwaprjkrm")
	}
}

func TestParseInviteCode(t *testing.T) {
	tests := map[string]string{
		"abc-defg-hij":     "abcdefghij",
		"ABCDEFGHIJ":       "abcdefghij",
		" ABC-DEFG-HIJ \n": "abcdefghij",
		"abcdefghij":       "abcdefghij",
	}
	for raw, want := range tests {
		got, ok := ParseInviteCode(raw)
		if !ok || got != want {
			t.Errorf("ParseInviteCode(%q) = %q, %v; want %q, true", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"", "abcdefghi", "abc-defg-hijk", "ab-cdefg-hij", "abc_defg_hij", "abcdefghi1", "ébcdefghij"} {
		if got, ok := ParseInviteCode(raw); ok {
			t.Errorf("ParseInviteCode(%q) = %q, true; want false", raw, got)
		}
	}
}

func TestFormatInviteCode(t *testing.T) {
	if got := FormatInviteCode("abcdefghij"); got != "abc-defg-hij" {
		t.Fatalf("FormatInviteCode() = %q", got)
	}
}

func TestWordInviteParsing(t *testing.T) {
	const want = "apple-tiger-lamp-river"
	for _, raw := range []string{want, "  APPLE Tiger . lamp-river  ", "apple.tiger.lamp.river", "https://chalkmeet.com/APPLE-TIGER-LAMP-RIVER", "chalkmeet.com/apple-tiger-lamp-river"} {
		if got, ok := ParseInviteCode(raw); !ok || got != want || FormatInviteCode(got) != want {
			t.Errorf("parse %q: %q, %v", raw, got, ok)
		}
	}
	for _, raw := range []string{"apple-tiger-lamp", "apple-tiger-lamp-river-cloud", "unknown-tiger-lamp-river", "hate-tiger-lamp-river", "apple/tiger/lamp/river", "https://evil.example/" + want, "https://chalkmeet.com/" + want + "?x=y"} {
		if _, ok := ParseInviteCode(raw); ok {
			t.Errorf("accepted %q", raw)
		}
	}
}

func TestWordInviteDictionary(t *testing.T) {
	if len(inviteWords) != 1024 || len(inviteWordSet) != 1024 {
		t.Fatal("dictionary must contain 1024 distinct words")
	}
	for _, word := range inviteWords {
		if !lowercaseLetters(word) {
			t.Fatalf("invalid word %q", word)
		}
	}
	for i := range 256 {
		code := InviteWordCode(repeatedCodeBytes(byte(i)))
		if parsed, ok := ParseInviteCode(code); !ok || parsed != code {
			t.Fatalf("generated invalid code %q", code)
		}
	}
}
