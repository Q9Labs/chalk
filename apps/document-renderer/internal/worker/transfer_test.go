package worker

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
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

func TestDownloadParallelRangesVerifiesDigest(t *testing.T) {
	body := make([]byte, 2*1024*1024+17)
	for index := range body {
		body[index] = byte(index % 251)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var start, end int
		if _, err := fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &start, &end); err != nil {
			t.Errorf("missing range header %q", r.Header.Get("Range"))
			w.WriteHeader(http.StatusOK)
			return
		}
		end = min(end, len(body)-1)
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(body)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(body[start : end+1])
	}))
	defer server.Close()
	digest := sha256.Sum256(body)
	got, err := download(t.Context(), server.URL, int64(len(body)), hex.EncodeToString(digest[:]))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, body) {
		t.Fatal("ranged download reassembled different bytes")
	}
}
