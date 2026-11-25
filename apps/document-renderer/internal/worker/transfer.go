package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"time"
)

func download(ctx context.Context, url string, maxBytes int64, expectedSHA256 string) ([]byte, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("download source: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download source returned status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read source: %w", err)
	}
	if int64(len(body)) > maxBytes {
		return nil, fmt.Errorf("source exceeds size cap")
	}
	if expectedSHA256 != "" {
		digest := sha256.Sum256(body)
		if hex.EncodeToString(digest[:]) != expectedSHA256 {
			return nil, fmt.Errorf("source sha256 mismatch")
		}
	}
	return body, nil
}

func upload(ctx context.Context, target signedUpload, body []byte) error {
	client := &http.Client{Timeout: 30 * time.Second}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, target.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	for name, value := range target.Headers {
		request.Header.Set(name, value)
	}
	if request.Header.Get("content-type") == "" {
		request.Header.Set("content-type", "image/webp")
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("upload render: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("upload render returned status %d", response.StatusCode)
	}
	return nil
}
