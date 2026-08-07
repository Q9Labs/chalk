package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
)

func readSSE(ctx context.Context, reader io.Reader, after int64) (streamResult, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 1024), 1<<20)
	result := streamResult{LastCursor: after}
	var eventName, eventID string
	var data strings.Builder
	flush := func() error {
		if eventName == "" && data.Len() == 0 {
			return nil
		}
		if eventName == "control" {
			result.ControlSeen = true
		}
		if eventName == "delta" {
			var delta episodediagnostics.DiagnosticStreamDeltaV1
			if err := json.Unmarshal([]byte(data.String()), &delta); err != nil {
				return fmt.Errorf("decode SSE delta: %w", err)
			}
			result.Deltas++
			cursor := delta.Cursor
			if eventID != "" {
				parsed, err := strconv.ParseInt(eventID, 10, 64)
				if err != nil || parsed != cursor {
					return errors.New("SSE id did not match durable cursor")
				}
			}
			if result.LastCursor > 0 && cursor > result.LastCursor+1 {
				result.LostCursors += cursor - result.LastCursor - 1
				result.Gaps++
			}
			if cursor > result.LastCursor {
				result.LastCursor = cursor
			}
		}
		if eventName == "close" {
			var closePayload episodediagnostics.DiagnosticStreamCloseV1
			if err := json.Unmarshal([]byte(data.String()), &closePayload); err == nil {
				result.CloseCursor = closePayload.ResumableCursor
				if closePayload.ResumableCursor > result.LastCursor+1 {
					result.LostCursors += closePayload.ResumableCursor - result.LastCursor - 1
					result.Gaps++
				}
				if closePayload.ResumableCursor > result.LastCursor {
					result.LastCursor = closePayload.ResumableCursor
				}
			}
		}
		eventName, eventID = "", ""
		data.Reset()
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := flush(); err != nil {
				return result, err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		value = strings.TrimPrefix(value, " ")
		switch key {
		case "event":
			eventName = value
		case "id":
			eventID = value
		case "data":
			data.WriteString(value)
		}
	}
	if err := flush(); err != nil {
		return result, err
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, context.Canceled) && !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return result, err
	}
	return result, nil
}
