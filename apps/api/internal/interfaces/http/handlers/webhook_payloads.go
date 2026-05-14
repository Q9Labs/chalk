package handlers

// RecordingStatusWebhook matches Cloudflare RealtimeKit's recording.statusUpdate payload.
type RecordingStatusWebhook struct {
	Event     string               `json:"event"`
	Recording RecordingWebhookData `json:"recording"`
	Meeting   MeetingWebhookData   `json:"meeting"`
}

type RecordingWebhookData struct {
	ID                   string  `json:"id"`
	RecordingID          string  `json:"recordingId"`
	DownloadURL          *string `json:"download_url"`
	DownloadURLAlt       *string `json:"downloadUrl"`
	DownloadURLExpiry    *string `json:"download_url_expiry"`
	DownloadURLExpiryAlt *string `json:"downloadUrlExpiry"`
	FileSize             *int64  `json:"file_size"`
	FileSizeAlt          *int64  `json:"fileSize"`
	SessionID            string  `json:"session_id"`
	RoomUUID             string  `json:"roomUUID"`
	OutputFileName       string  `json:"output_file_name"`
	OutputFileNameAlt    string  `json:"outputFileName"`
	Status               string  `json:"status"` // INVOKED, RECORDING, UPLOADING, UPLOADED, ERRORED
	InvokedTime          string  `json:"invoked_time"`
	InvokedTimeAlt       string  `json:"invokedTime"`
	StartedTime          *string `json:"started_time"`
	StartedTimeAlt       *string `json:"startedTime"`
	StoppedTime          *string `json:"stopped_time"`
	StoppedTimeAlt       *string `json:"stoppedTime"`
	MeetingID            string  `json:"meetingId"`
	OrganizationID       string  `json:"organizationId"`
	StopReason           string  `json:"stopReason"`
	RecordingDuration    float64 `json:"recordingDuration"`
}

type MeetingWebhookData struct {
	ID          string                       `json:"id"`
	SessionID   string                       `json:"sessionId"`
	Title       string                       `json:"title"`
	RoomName    string                       `json:"roomName"`
	Status      string                       `json:"status"`
	CreatedAt   *string                      `json:"createdAt"`
	StartedAt   *string                      `json:"startedAt"`
	EndedAt     *string                      `json:"endedAt"`
	OrganizedBy *MeetingOrganizerWebhookData `json:"organizedBy"`
}

type MeetingOrganizerWebhookData struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func normalizeRecordingWebhook(webhook *RecordingStatusWebhook) {
	if webhook == nil {
		return
	}

	normalizeRecordingData(&webhook.Recording)
	normalizeMeetingData(&webhook.Meeting)

	if webhook.Meeting.ID == "" && webhook.Recording.MeetingID != "" {
		webhook.Meeting.ID = webhook.Recording.MeetingID
	}
}

func normalizeRecordingData(recording *RecordingWebhookData) {
	if recording == nil {
		return
	}

	if recording.ID == "" && recording.RecordingID != "" {
		recording.ID = recording.RecordingID
	}
	if recording.DownloadURL == nil && recording.DownloadURLAlt != nil {
		recording.DownloadURL = recording.DownloadURLAlt
	}
	if recording.DownloadURLExpiry == nil && recording.DownloadURLExpiryAlt != nil {
		recording.DownloadURLExpiry = recording.DownloadURLExpiryAlt
	}
	if recording.FileSize == nil && recording.FileSizeAlt != nil {
		recording.FileSize = recording.FileSizeAlt
	}
	if recording.SessionID == "" && recording.RoomUUID != "" {
		recording.SessionID = recording.RoomUUID
	}
	if recording.OutputFileName == "" && recording.OutputFileNameAlt != "" {
		recording.OutputFileName = recording.OutputFileNameAlt
	}
	if recording.InvokedTime == "" && recording.InvokedTimeAlt != "" {
		recording.InvokedTime = recording.InvokedTimeAlt
	}
	if recording.StartedTime == nil && recording.StartedTimeAlt != nil {
		recording.StartedTime = recording.StartedTimeAlt
	}
	if recording.StoppedTime == nil && recording.StoppedTimeAlt != nil {
		recording.StoppedTime = recording.StoppedTimeAlt
	}
}

func normalizeMeetingData(meeting *MeetingWebhookData) {
	if meeting == nil {
		return
	}

	if meeting.Title == "" && meeting.RoomName != "" {
		meeting.Title = meeting.RoomName
	}
}
