package publicinvites

import "testing"

func TestInviteCodeFixedVector(t *testing.T) {
	handle := make([]byte, 32)
	for i := range handle {
		handle[i] = byte(i)
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
