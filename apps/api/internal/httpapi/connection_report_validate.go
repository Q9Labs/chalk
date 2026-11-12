package httpapi

import "slices"

// connectionReportRejection returns the label of the first rule the report
// breaks, or "" when the report is valid. Labels are fixed strings, so they are
// safe to log.
func connectionReportRejection(report connectionReport) string {
	switch {
	case report.Version != 1:
		return "version"
	case !slices.Contains(ConnectionReportFieldEnum("trigger"), report.Trigger):
		return "trigger"
	case len(report.Events) == 0 || len(report.Events) > ConnectionReportEventLimit:
		return "event_count"
	}
	var previous int64
	for _, event := range report.Events {
		if reason := event.rejection(previous); reason != "" {
			return reason
		}
		previous = event.ElapsedMS
	}
	return ""
}

type connectionReportLabel struct {
	field string
	value string
}

func (event connectionReportEvent) rejection(previous int64) string {
	for _, check := range []func() string{
		func() string { return event.orderRejection(previous) },
		event.receiveLabelRejection,
		event.receiveCountsRejection,
		event.receiversClosedRejection,
		event.stateLabelRejection,
		event.rangeRejection,
	} {
		if reason := check(); reason != "" {
			return reason
		}
	}
	return ""
}

func (event connectionReportEvent) orderRejection(previous int64) string {
	switch {
	case !slices.Contains(ConnectionReportFieldEnum("event"), event.Event):
		return "event_label"
	case event.ElapsedMS < 0 || event.ElapsedMS > ConnectionReportMaxMilliseconds:
		return "elapsed_range"
	case event.ElapsedMS < previous:
		return "event_order"
	case event.UploadFailure != "" && event.Event != "chat_upload_failed":
		return "upload_failure_event"
	}
	return ""
}

func (event connectionReportEvent) receiveLabelRejection() string {
	return unknownLabel([]connectionReportLabel{
		{"receive_state", event.ReceiveState},
		{"track_state", event.TrackState},
		{"element_state", event.ElementState},
		{"play_result", event.PlayResult},
		{"upload_failure", event.UploadFailure},
	})
}

func (event connectionReportEvent) stateLabelRejection() string {
	return unknownLabel([]connectionReportLabel{
		{"state", event.State},
		{"step", event.Step},
		{"outcome", event.Outcome},
		{"code", event.Code},
		{"phase", event.Phase},
		{"media_error_kind", event.MediaErrorKind},
		{"media_error_step", event.MediaErrorStep},
		{"granted_audio", event.GrantedAudio},
		{"granted_video", event.GrantedVideo},
		{"source", event.Source},
		{"publication_state", event.PublicationState},
		{"projection_state", event.ProjectionState},
	})
}

func unknownLabel(labels []connectionReportLabel) string {
	for _, label := range labels {
		if label.value != "" && !slices.Contains(ConnectionReportFieldEnum(label.field), label.value) {
			return label.field + "_label"
		}
	}
	return ""
}

func (event connectionReportEvent) receiveCountsRejection() string {
	counts := event.ReceiveCounts
	if counts == nil {
		return ""
	}
	if event.Event != "audio_receive_summary" {
		return "receive_counts_event"
	}
	for _, value := range []*int64{counts.Announced, counts.PullRequested, counts.PullFailed, counts.PullSucceeded, counts.TrackReceived, counts.BytesFlowing, counts.ElementBound, counts.Playing, counts.ProjectionOff} {
		if value != nil && (*value < 0 || *value > ConnectionReportMaxReceiveCount) {
			return "receive_counts_range"
		}
	}
	return ""
}

func (event connectionReportEvent) receiversClosedRejection() string {
	if event.ReceiversStopped == nil && event.BundleTagHeld == nil {
		return ""
	}
	if event.Event != "receivers_closed" {
		return "receivers_closed_event"
	}
	if event.ReceiversStopped != nil && (*event.ReceiversStopped < 0 || *event.ReceiversStopped > ConnectionReportMaxReceiveCount) {
		return "receivers_stopped_range"
	}
	return ""
}

func (event connectionReportEvent) rangeRejection() string {
	for _, field := range []struct {
		name  string
		value *int64
	}{
		{"attempt", event.Attempt},
		{"duration_ms", event.DurationMS},
		{"heartbeat_gap_ms", event.HeartbeatGapMS},
	} {
		if field.value != nil && (*field.value < 0 || *field.value > ConnectionReportMaxMilliseconds) {
			return field.name + "_range"
		}
	}
	switch {
	case event.CloseCode != nil && (*event.CloseCode < 1000 || *event.CloseCode > 4999):
		return "close_code_range"
	case event.HTTPStatus != nil && (*event.HTTPStatus < 400 || *event.HTTPStatus > 599):
		return "http_status_range"
	}
	return ""
}
