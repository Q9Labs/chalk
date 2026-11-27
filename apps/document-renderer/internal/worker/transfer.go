package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	controlplane "github.com/q9labs/chalk/apps/document-renderer/internal/control"
)

func download(ctx context.Context, url string, maxBytes int64, expectedSHA256 string) ([]byte, error) {
	const chunkSize = 1024 * 1024
	first, total, complete, err := downloadRange(ctx, url, 0, chunkSize-1, maxBytes)
	if err != nil {
		return nil, err
	}
	if complete {
		return verifySource(first, maxBytes, expectedSHA256)
	}
	if total > maxBytes {
		return nil, fmt.Errorf("source exceeds size cap")
	}
	body := make([]byte, total)
	copy(body, first)
	type chunkResult struct {
		start int64
		data  []byte
		err   error
	}
	jobs := make(chan int64)
	results := make(chan chunkResult, (total+chunkSize-1)/chunkSize)
	var workers sync.WaitGroup
	for range 4 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for start := range jobs {
				end := min(start+chunkSize-1, total-1)
				data, _, _, err := downloadRange(ctx, url, start, end, maxBytes)
				results <- chunkResult{start: start, data: data, err: err}
			}
		}()
	}
	go func() {
		for start := int64(chunkSize); start < total; start += chunkSize {
			jobs <- start
		}
		close(jobs)
		workers.Wait()
		close(results)
	}()
	var firstErr error
	for result := range results {
		if result.err != nil && firstErr == nil {
			firstErr = result.err
			continue
		}
		copy(body[result.start:], result.data)
	}
	if firstErr != nil {
		return nil, firstErr
	}
	return verifySource(body, maxBytes, expectedSHA256)
}

func downloadRange(ctx context.Context, url string, start, end, maxBytes int64) ([]byte, int64, bool, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, false, err
	}
	request.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	response, err := client.Do(request)
	if err != nil {
		return nil, 0, false, transferTransportError("download source")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusOK {
		body, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
		if err != nil {
			return nil, 0, false, transferTransportError("read source")
		}
		return body, int64(len(body)), true, nil
	}
	if response.StatusCode != http.StatusPartialContent {
		return nil, 0, false, fmt.Errorf("download source returned status %d", response.StatusCode)
	}
	var rangeStart, rangeEnd, total int64
	if _, err := fmt.Sscanf(response.Header.Get("Content-Range"), "bytes %d-%d/%d", &rangeStart, &rangeEnd, &total); err != nil || rangeStart != start || rangeEnd > end || total < 1 {
		return nil, 0, false, fmt.Errorf("download source returned invalid content range")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, end-start+2))
	if err != nil {
		return nil, 0, false, transferTransportError("read source range")
	}
	if int64(len(body)) != rangeEnd-rangeStart+1 {
		return nil, 0, false, fmt.Errorf("download source returned a short range")
	}
	return body, total, false, nil
}

func verifySource(body []byte, maxBytes int64, expectedSHA256 string) ([]byte, error) {
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

func upload(ctx context.Context, target controlplane.SignedUpload, body []byte) error {
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
		return transferTransportError("upload render")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("upload render returned status %d", response.StatusCode)
	}
	return nil
}

type transferError string

func (e transferError) Error() string { return string(e) }

func transferTransportError(operation string) error {
	return transferError(operation + " transport failed")
}
