package webhooks

type eventEnvelope[T any] struct {
	ID         string    `json:"id"`
	Event      EventName `json:"event"`
	APIVersion int       `json:"api_version"`
	OccurredAt string    `json:"occurred_at"`
	TenantID   string    `json:"tenant_id"`
	Data       T         `json:"data"`
}

type spaceData struct {
	Object        spaceObject `json:"object"`
	ChangedFields []string    `json:"changed_fields,omitempty"`
}

type spaceObject struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Slug       string  `json:"slug"`
	MediaPlane string  `json:"media_plane"`
	ArchivedAt *string `json:"archived_at,omitempty"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
}

type episodeData struct {
	Object episodeObject `json:"object"`
}

type episodeObject struct {
	ID        string  `json:"id"`
	SpaceID   string  `json:"space_id"`
	Status    string  `json:"status"`
	StartedAt *string `json:"started_at"`
	EndedAt   *string `json:"ended_at"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

type testData struct {
	Object struct {
		EndpointID string `json:"endpoint_id"`
	} `json:"object"`
}

type recordingData struct {
	Object recordingObject `json:"object"`
}

type recordingObject struct {
	ID          string           `json:"id"`
	SpaceID     string           `json:"space_id"`
	EpisodeID   string           `json:"episode_id"`
	Status      string           `json:"status"`
	StartedAt   *string          `json:"started_at"`
	CompletedAt *string          `json:"completed_at"`
	FailedAt    *string          `json:"failed_at"`
	Failure     *ArtifactFailure `json:"failure"`
	CreatedAt   string           `json:"created_at"`
	UpdatedAt   string           `json:"updated_at"`
}

type transcriptData struct {
	Object transcriptObject `json:"object"`
}

type transcriptObject struct {
	ID          string           `json:"id"`
	RecordingID string           `json:"recording_id"`
	SpaceID     string           `json:"space_id"`
	EpisodeID   string           `json:"episode_id"`
	Status      string           `json:"status"`
	Languages   []string         `json:"languages"`
	StartedAt   *string          `json:"started_at"`
	CompletedAt *string          `json:"completed_at"`
	FailedAt    *string          `json:"failed_at"`
	Failure     *ArtifactFailure `json:"failure"`
	CreatedAt   string           `json:"created_at"`
	UpdatedAt   string           `json:"updated_at"`
}
