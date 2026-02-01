package handlers

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

func shouldProcessRecording(status string) bool {
	switch strings.ToUpper(status) {
	case "UPLOADED", "COMPLETED":
		return true
	default:
		return false
	}
}

func streamDownload(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf(
			"download failed: status=%d content_type=%s content_length=%d",
			resp.StatusCode,
			resp.Header.Get("Content-Type"),
			resp.ContentLength,
		)
	}

	return resp, nil
}

func mapToSlogAttrs(m map[string]any) []any {
	attrs := make([]any, 0, len(m)*2)
	for k, v := range m {
		attrs = append(attrs, k, v)
	}
	return attrs
}
