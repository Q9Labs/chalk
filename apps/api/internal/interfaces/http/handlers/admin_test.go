package handlers

import (
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestParseWhisperProcessingJobIDs(t *testing.T) {
	jobIDOne := uuid.New()
	jobIDTwo := uuid.New()

	jobIDs := parseWhisperProcessingJobIDs([]string{
		`{"job_id":"` + jobIDOne.String() + `"}`,
		`{"job_id":"` + jobIDTwo.String() + `"}`,
		`{"job_id":"` + jobIDOne.String() + `"}`,
		`{"job_id":"not-a-uuid"}`,
		`{"oops":true}`,
		`not-json`,
	})

	require.Equal(t, []uuid.UUID{jobIDOne, jobIDTwo}, jobIDs)
}
