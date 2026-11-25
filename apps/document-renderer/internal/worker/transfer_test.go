package worker

import (
	"errors"
	"testing"
)

func TestTransferTransportErrorHidesSignedURL(t *testing.T) {
	err := transferTransportError("upload render")
	if err == nil || err.Error() != "upload render transport failed" {
		t.Fatalf("unexpected transfer error %v", err)
	}
	if errors.Is(err, errors.New("token")) {
		t.Fatal("impossible")
	}
	for _, secret := range []string{"X-Amz-Signature", "https://", "token"} {
		if contains(err.Error(), secret) {
			t.Fatalf("transfer error leaked %q in %q", secret, err.Error())
		}
	}
}

func contains(value, substring string) bool {
	return len(substring) == 0 || (len(value) >= len(substring) && func() bool {
		for index := 0; index+len(substring) <= len(value); index++ {
			if value[index:index+len(substring)] == substring {
				return true
			}
		}
		return false
	}())
}
