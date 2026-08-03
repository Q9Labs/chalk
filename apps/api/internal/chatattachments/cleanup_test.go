package chatattachments

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestCleanupUsesSevenDayEndedEpisodeRetentionAndDeletesObjectFirst(t *testing.T) {
	now := time.Date(2026, time.July, 30, 12, 0, 0, 0, time.UTC)
	claim := chatCleanupTestClaim(t)
	events := []string{}
	repository := &chatCleanupRepositoryStub{
		claims: []CleanupClaim{claim},
		events: &events,
	}
	objects := &chatCleanupObjectStoreStub{events: &events}
	worker := NewCleanupWorker(repository, objects)
	worker.now = func() time.Time { return now }
	worker.batchSize = 10

	result, err := worker.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result != (CleanupResult{Batches: 1, Claimed: 1, Deleted: 1}) {
		t.Fatalf("result = %#v", result)
	}
	if repository.input.EndedBefore != now.Add(-7*24*time.Hour) {
		t.Fatalf("ended before = %s", repository.input.EndedBefore)
	}
	if got := fmt.Sprint(events); got != "[delete complete]" {
		t.Fatalf("events = %s", got)
	}
}

func TestCleanupDoesNotRemoveRowWhenObjectDeleteFails(t *testing.T) {
	claim := chatCleanupTestClaim(t)
	events := []string{}
	repository := &chatCleanupRepositoryStub{
		claims: []CleanupClaim{claim},
		events: &events,
	}
	objects := &chatCleanupObjectStoreStub{
		events: &events,
		err:    objectstorage.ErrProviderFailed,
	}
	worker := NewCleanupWorker(repository, objects)

	result, err := worker.Run(context.Background())
	if !errors.Is(err, objectstorage.ErrProviderFailed) {
		t.Fatalf("error = %v", err)
	}
	if result.Failed != 1 || result.Deleted != 0 {
		t.Fatalf("result = %#v", result)
	}
	if got := fmt.Sprint(events); got != "[delete]" {
		t.Fatalf("events = %s", got)
	}
}

type chatCleanupRepositoryStub struct {
	claims []CleanupClaim
	input  CleanupClaimInput
	events *[]string
}

func (s *chatCleanupRepositoryStub) ClaimCleanup(
	_ context.Context,
	input CleanupClaimInput,
) ([]CleanupClaim, error) {
	s.input = input
	claims := s.claims
	s.claims = nil
	return claims, nil
}

func (s *chatCleanupRepositoryStub) CompleteCleanup(
	context.Context,
	CleanupClaim,
) error {
	*s.events = append(*s.events, "complete")
	return nil
}

type chatCleanupObjectStoreStub struct {
	events *[]string
	err    error
}

func (s *chatCleanupObjectStoreStub) DeleteObject(context.Context, string) error {
	*s.events = append(*s.events, "delete")
	return s.err
}

func chatCleanupTestClaim(t *testing.T) CleanupClaim {
	t.Helper()
	return CleanupClaim{
		TenantID:     chatAttachmentTestID(t, "11111111-1111-4111-8111-111111111111"),
		EpisodeID:    chatAttachmentTestID(t, "33333333-3333-4333-8333-333333333333"),
		AttachmentID: chatAttachmentTestID(t, "55555555-5555-4555-8555-555555555555"),
		ObjectKey:    "chat-attachments-v1/test-object",
		Token:        chatAttachmentTestID(t, "77777777-7777-4777-8777-777777777777"),
	}
}

var _ CleanupRepository = (*chatCleanupRepositoryStub)(nil)
var _ ObjectDeleter = (*chatCleanupObjectStoreStub)(nil)
var _ = utilities.ID{}
