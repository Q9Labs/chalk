package providerbridge

import (
	"context"
	"encoding/base64"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	testProviderCloseFanOut = 8
	testProviderCloseBudget = 200 * time.Millisecond
)

func TestForcedMuteClosesCloudflareTrack(t *testing.T) {
	ctx := context.Background()
	tenantID := testExecutorID(t, "11111111-1111-4111-8111-111111111111")
	episodeID := testExecutorID(t, "22222222-2222-4222-8222-222222222222")
	participantID := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
	publicationID := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"c":"publisher-connection","m":"0","t":"microphone-track","g":1}`))
	registry := &executorPublicationRegistry{publication: provideroperations.Publication{ParticipantID: participantID, Source: "microphone", Enabled: true, PublicationID: publicationID}}
	closer := &executorTrackCloser{}
	executor := NewSFUExecutor(registry, closer)
	operation := provideroperations.OperationInput{Effect: provideroperations.EffectRevokePublication, TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1, PublicationSource: "microphone"}

	if result := executor.Dispatch(ctx, operation); result.Outcome != provideroperations.OutcomeConfirmed {
		t.Fatalf("forced mute outcome = %+v", result)
	}
	if registry.publication.Enabled || registry.publication.PublicationID != "" || closer.calls != 1 || !closer.force {
		t.Fatalf("forced mute did not close Cloudflare SFU track: publication=%+v closes=%d", registry.publication, closer.calls)
	}

	operation.Effect = provideroperations.EffectGrantPublication
	if result := executor.Dispatch(ctx, operation); result.Outcome != provideroperations.OutcomeConfirmed {
		t.Fatalf("re-enable outcome = %+v", result)
	}
	if registry.publication.PublicationID != "" || closer.calls != 1 {
		t.Fatalf("re-enable restored a closed Cloudflare SFU track: publication=%+v closes=%d", registry.publication, closer.calls)
	}

	operation.Effect = provideroperations.EffectRevokePublication
	_ = executor.Dispatch(ctx, operation)
	operation.Effect = provideroperations.EffectRemoveParticipant
	if result := executor.Dispatch(ctx, operation); result.Outcome != provideroperations.OutcomeSatisfied {
		t.Fatalf("removal outcome = %+v", result)
	}
	if closer.calls != 1 || registry.publication.PublicationID != "" {
		t.Fatalf("closed track was closed again: publication=%+v closes=%d", registry.publication, closer.calls)
	}
	registry.publication.PublicationID = publicationID
	operation.Effect = provideroperations.EffectRevokePublication
	if result := executor.Dispatch(ctx, operation); result.Outcome != provideroperations.OutcomeConfirmed || closer.calls != 2 {
		t.Fatalf("paused track was not force-closed: outcome=%+v closes=%d", result, closer.calls)
	}
}

type executorPublicationRegistry struct {
	publication provideroperations.Publication
}

func (*executorPublicationRegistry) RecordPublishedTracks(context.Context, mediapublications.RecordInput) ([]mediapublications.PublishedReference, error) {
	return nil, nil
}

func (*executorPublicationRegistry) PrepareClose(context.Context, mediapublications.CloseInput) (mediapublications.CloseDecision, error) {
	return mediapublications.CloseDecision{}, nil
}

func (r *executorPublicationRegistry) RecordClosedPublication(_ context.Context, _ mediapublications.CloseInput) error {
	r.publication.Enabled = false
	r.publication.PublicationID = ""
	return nil
}

func (r *executorPublicationRegistry) RecordPublicationAvailability(_ context.Context, input mediapublications.AvailabilityInput) error {
	if r.publication.PublicationID == input.PublicationID {
		r.publication.Enabled = input.Enabled
	}
	return nil
}

func (r *executorPublicationRegistry) Latest(context.Context, utilities.ID, utilities.ID) (mediapublications.Snapshot, error) {
	return mediapublications.Snapshot{Publications: []provideroperations.Publication{r.publication}}, nil
}

type executorTrackCloser struct {
	calls int
	force bool
	err   error
}

func (c *executorTrackCloser) CloseTracks(_ context.Context, input mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	c.calls++
	c.force = input.Force
	return mediaplane.CloseTracksResponse{}, c.err
}

func testExecutorID(t *testing.T, raw string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(raw)
	if err != nil {
		t.Fatalf("parse ID: %v", err)
	}
	return id
}

func TestStaleConnectionEndReconcilesDispatchingReceipt(t *testing.T) {
	input := testEndOperation(t)
	participantID := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
	publicationID := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"c":"stale-connection","m":"0","t":"microphone-track","g":1}`))
	registry := &executorPublicationRegistry{publication: provideroperations.Publication{ParticipantID: participantID, Source: "microphone", Enabled: true, PublicationID: publicationID}}
	client := &executorTrackCloser{err: mediaplane.ErrConnectionNotFound}
	repository := &failureReceiptRepository{}
	_, _ = repository.Prepare(context.Background(), input)
	_, _ = repository.MarkDispatching(context.Background(), input.OperationID, input.Effect)
	service := NewService(repository, NewSFUExecutor(registry, client))
	result, err := service.Execute(context.Background(), input)
	if err != nil || result.Outcome != provideroperations.OutcomeSatisfied || registry.publication.PublicationID != "" || repository.receipt.State != provideroperations.ReceiptCompleted {
		t.Fatalf("stale end = %+v, %v, receipt=%+v", result, err, repository.receipt)
	}
	_, err = service.Execute(context.Background(), input)
	if err != nil || client.calls != 1 {
		t.Fatalf("completed replay sent another close: calls=%d err=%v", client.calls, err)
	}
}

func TestEndEpisodeClosesGhostConnectionsInParallel(t *testing.T) {
	registry, connectionIDs, publicationIDs := newMultiExecutorPublicationRegistry(t, 12)
	plans := make(map[string][]multiExecutorClosePlan, len(connectionIDs))
	for _, connectionID := range connectionIDs {
		plans[connectionID] = []multiExecutorClosePlan{{delay: 100 * time.Millisecond, response: mediaplane.CloseTracksResponse{AlreadyClosed: true}}}
	}
	closer := newMultiExecutorTrackCloser(plans)
	executor := NewSFUExecutor(registry, closer)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	started := time.Now()
	result := executor.Dispatch(ctx, testEndOperation(t))
	elapsed := time.Since(started)
	t.Logf("closed %d ghost connections in %s", len(connectionIDs), elapsed)
	if result.Outcome != provideroperations.OutcomeSatisfied {
		t.Fatalf("end episode outcome = %+v, want satisfied", result)
	}
	if elapsed >= 400*time.Millisecond {
		t.Fatalf("end episode took %s, want under 400ms", elapsed)
	}
	if max := closer.maxConcurrent(); max <= 1 || max > testProviderCloseFanOut {
		t.Fatalf("maximum concurrent closes = %d, want 2..%d", max, testProviderCloseFanOut)
	}
	if calls := closer.totalCalls(); calls != len(connectionIDs) {
		t.Fatalf("close calls = %d, want %d", calls, len(connectionIDs))
	}
	if got := registry.recordedPublicationIDs(); !equalStrings(got, publicationIDs) {
		t.Fatalf("recorded publications = %v, want %v", got, publicationIDs)
	}
	if got := registry.activeCount(); got != 0 {
		t.Fatalf("active publications = %d, want 0", got)
	}
}

func TestEndEpisodeReturnsWithinCloseBudget(t *testing.T) {
	registry, connectionIDs, _ := newMultiExecutorPublicationRegistry(t, 40)
	plans := make(map[string][]multiExecutorClosePlan, len(connectionIDs))
	for _, connectionID := range connectionIDs {
		plans[connectionID] = []multiExecutorClosePlan{{waitForContext: true}}
	}
	closer := newMultiExecutorTrackCloser(plans)
	executor := NewSFUExecutor(registry, closer)
	executor.closeBudget = testProviderCloseBudget
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	started := time.Now()
	result := executor.Dispatch(ctx, testEndOperation(t))
	elapsed := time.Since(started)
	if result.Outcome != provideroperations.OutcomeRetryableFailure || result.Reason != "timeout" {
		t.Fatalf("end episode outcome = %+v, want retryable timeout", result)
	}
	if elapsed >= 2*testProviderCloseBudget {
		t.Fatalf("end episode took %s, want within the close budget plus margin", elapsed)
	}
	if max := closer.maxConcurrent(); max <= 1 || max > testProviderCloseFanOut {
		t.Fatalf("maximum concurrent closes = %d, want 2..%d", max, testProviderCloseFanOut)
	}
}

func TestEndEpisodeKeepsProviderFailureAheadOfCloseBudget(t *testing.T) {
	registry, connectionIDs, _ := newMultiExecutorPublicationRegistry(t, 4)
	plans := map[string][]multiExecutorClosePlan{
		connectionIDs[0]: {{err: fmt.Errorf("provider A: %w", mediaplane.ErrProviderFailed)}},
		connectionIDs[1]: {{waitForContext: true}},
		connectionIDs[2]: {{}},
		connectionIDs[3]: {{}},
	}
	closer := newMultiExecutorTrackCloser(plans)
	executor := NewSFUExecutor(registry, closer)
	executor.closeBudget = testProviderCloseBudget
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	result := executor.Dispatch(ctx, testEndOperation(t))
	if result.Outcome != provideroperations.OutcomeAmbiguous || result.Reason != "provider_result_ambiguous" {
		t.Fatalf("end episode outcome = %+v, want A's ambiguous provider failure", result)
	}
	wantRecorded := registry.publicationIDsForConnections(connectionIDs[2:])
	if got := registry.recordedPublicationIDs(); !equalStrings(got, wantRecorded) {
		t.Fatalf("recorded publications = %v, want fast successful closes %v", got, wantRecorded)
	}
}

func TestEndEpisodeRetryAfterPartialCloseConverges(t *testing.T) {
	registry, connectionIDs, _ := newMultiExecutorPublicationRegistry(t, 12)
	plans := make(map[string][]multiExecutorClosePlan, len(connectionIDs))
	for index, connectionID := range connectionIDs {
		if index < len(connectionIDs)/2 {
			plans[connectionID] = []multiExecutorClosePlan{{delay: 10 * time.Millisecond}}
		} else {
			plans[connectionID] = []multiExecutorClosePlan{{waitForContext: true}, {}}
		}
	}
	closer := newMultiExecutorTrackCloser(plans)
	executor := NewSFUExecutor(registry, closer)
	executor.closeBudget = testProviderCloseBudget
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	started := time.Now()
	first := executor.Dispatch(ctx, testEndOperation(t))
	elapsed := time.Since(started)
	if first.Outcome != provideroperations.OutcomeRetryableFailure || first.Reason != "timeout" {
		t.Fatalf("first end episode outcome = %+v, want retryable timeout", first)
	}
	if elapsed >= 2*testProviderCloseBudget {
		t.Fatalf("first end episode took %s, want within the close budget plus margin", elapsed)
	}
	wantInitiallyClosed := registry.publicationIDsForConnections(connectionIDs[:len(connectionIDs)/2])
	if got := registry.recordedPublicationIDs(); !equalStrings(got, wantInitiallyClosed) {
		t.Fatalf("first dispatch recorded publications = %v, want %v", got, wantInitiallyClosed)
	}

	second := executor.Dispatch(context.Background(), testEndOperation(t))
	if second.Outcome != provideroperations.OutcomeConfirmed {
		t.Fatalf("second end episode outcome = %+v, want confirmed", second)
	}
	for index, connectionID := range connectionIDs {
		wantCalls := 1
		if index >= len(connectionIDs)/2 {
			wantCalls = 2
		}
		if got := closer.callsFor(connectionID); got != wantCalls {
			t.Errorf("close calls for %s = %d, want %d", connectionID, got, wantCalls)
		}
	}

	cleanRegistry, cleanConnections, _ := newMultiExecutorPublicationRegistry(t, 12)
	cleanPlans := make(map[string][]multiExecutorClosePlan, len(cleanConnections))
	for _, connectionID := range cleanConnections {
		cleanPlans[connectionID] = []multiExecutorClosePlan{{}}
	}
	cleanCloser := newMultiExecutorTrackCloser(cleanPlans)
	clean := NewSFUExecutor(cleanRegistry, cleanCloser).Dispatch(context.Background(), testEndOperation(t))
	if clean.Outcome != provideroperations.OutcomeConfirmed {
		t.Fatalf("clean end episode outcome = %+v, want confirmed", clean)
	}
	if got, want := registry.state(), cleanRegistry.state(); !equalPublicationStates(got, want) {
		t.Fatalf("converged registry state = %v, want clean-run state %v", got, want)
	}
}

func TestEndEpisodeMapsAlreadyClosedAndMissingConnections(t *testing.T) {
	registry, connectionIDs, publicationIDs := newMultiExecutorPublicationRegistry(t, 3)
	plans := map[string][]multiExecutorClosePlan{
		connectionIDs[0]: {{response: mediaplane.CloseTracksResponse{AlreadyClosed: true}}},
		connectionIDs[1]: {{}},
		connectionIDs[2]: {{err: mediaplane.ErrConnectionNotFound}},
	}
	closer := newMultiExecutorTrackCloser(plans)
	result := NewSFUExecutor(registry, closer).Dispatch(context.Background(), testEndOperation(t))
	if result.Outcome != provideroperations.OutcomeConfirmed {
		t.Fatalf("end episode outcome = %+v, want confirmed", result)
	}
	if got := registry.recordedPublicationIDs(); !equalStrings(got, publicationIDs) {
		t.Fatalf("recorded publications = %v, want %v", got, publicationIDs)
	}
}

type multiExecutorClosePlan struct {
	delay          time.Duration
	response       mediaplane.CloseTracksResponse
	err            error
	waitForContext bool
}

type multiExecutorTrackCloser struct {
	mu          sync.Mutex
	plans       map[string][]multiExecutorClosePlan
	calls       map[string]int
	inFlight    int
	maxInFlight int
}

func newMultiExecutorTrackCloser(plans map[string][]multiExecutorClosePlan) *multiExecutorTrackCloser {
	return &multiExecutorTrackCloser{plans: plans, calls: make(map[string]int)}
}

func (c *multiExecutorTrackCloser) CloseTracks(ctx context.Context, input mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	c.mu.Lock()
	callNumber := c.calls[input.ConnectionID]
	c.calls[input.ConnectionID] = callNumber + 1
	c.inFlight++
	if c.inFlight > c.maxInFlight {
		c.maxInFlight = c.inFlight
	}
	var plan multiExecutorClosePlan
	if connectionPlans := c.plans[input.ConnectionID]; len(connectionPlans) > 0 {
		planIndex := callNumber
		if planIndex >= len(connectionPlans) {
			planIndex = len(connectionPlans) - 1
		}
		plan = connectionPlans[planIndex]
	}
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.inFlight--
		c.mu.Unlock()
	}()

	if plan.waitForContext {
		<-ctx.Done()
		return mediaplane.CloseTracksResponse{}, ctx.Err()
	}
	if plan.delay > 0 {
		timer := time.NewTimer(plan.delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return mediaplane.CloseTracksResponse{}, ctx.Err()
		}
	}
	return plan.response, plan.err
}

func (c *multiExecutorTrackCloser) callsFor(connectionID string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls[connectionID]
}

func (c *multiExecutorTrackCloser) totalCalls() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	total := 0
	for _, calls := range c.calls {
		total += calls
	}
	return total
}

func (c *multiExecutorTrackCloser) maxConcurrent() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.maxInFlight
}

type multiExecutorPublicationRegistry struct {
	mu           sync.Mutex
	publications map[string]provideroperations.Publication
	closed       []mediapublications.CloseInput
}

func newMultiExecutorPublicationRegistry(t *testing.T, count int) (*multiExecutorPublicationRegistry, []string, []string) {
	t.Helper()
	participantID := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
	registry := &multiExecutorPublicationRegistry{publications: make(map[string]provideroperations.Publication, count)}
	connectionIDs := make([]string, 0, count)
	publicationIDs := make([]string, 0, count)
	for index := 0; index < count; index++ {
		connectionID := fmt.Sprintf("ghost-connection-%02d", index)
		publicationID := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"c":%q,"m":%q,"t":%q,"g":1}`, connectionID, fmt.Sprint(index), fmt.Sprintf("track-%d", index))))
		registry.publications[publicationID] = provideroperations.Publication{
			ParticipantID: participantID, Source: "microphone", Enabled: true, PublicationID: publicationID,
		}
		connectionIDs = append(connectionIDs, connectionID)
		publicationIDs = append(publicationIDs, publicationID)
	}
	sort.Strings(connectionIDs)
	sort.Strings(publicationIDs)
	return registry, connectionIDs, publicationIDs
}

func (*multiExecutorPublicationRegistry) RecordPublishedTracks(context.Context, mediapublications.RecordInput) ([]mediapublications.PublishedReference, error) {
	return nil, nil
}

func (*multiExecutorPublicationRegistry) PrepareClose(context.Context, mediapublications.CloseInput) (mediapublications.CloseDecision, error) {
	return mediapublications.CloseDecision{}, nil
}

func (r *multiExecutorPublicationRegistry) RecordClosedPublication(_ context.Context, input mediapublications.CloseInput) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = append(r.closed, input)
	publication, ok := r.publications[input.PublicationID]
	if ok {
		publication.Enabled = false
		publication.PublicationID = ""
		r.publications[input.PublicationID] = publication
	}
	return nil
}

func (*multiExecutorPublicationRegistry) RecordPublicationAvailability(context.Context, mediapublications.AvailabilityInput) error {
	return nil
}

func (r *multiExecutorPublicationRegistry) Latest(context.Context, utilities.ID, utilities.ID) (mediapublications.Snapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	publications := make([]provideroperations.Publication, 0, len(r.publications))
	for _, publication := range r.publications {
		publications = append(publications, publication)
	}
	return mediapublications.Snapshot{Publications: publications}, nil
}

func (r *multiExecutorPublicationRegistry) recordedPublicationIDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, 0, len(r.closed))
	for _, input := range r.closed {
		ids = append(ids, input.PublicationID)
	}
	sort.Strings(ids)
	return ids
}

func (r *multiExecutorPublicationRegistry) publicationIDsForConnections(connectionIDs []string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	connectionSet := make(map[string]struct{}, len(connectionIDs))
	for _, connectionID := range connectionIDs {
		connectionSet[connectionID] = struct{}{}
	}
	ids := make([]string, 0, len(connectionIDs))
	for publicationID := range r.publications {
		reference, err := mediapublications.ParseReference(publicationID)
		if err != nil {
			continue
		}
		if _, ok := connectionSet[reference.ConnectionID]; ok {
			ids = append(ids, publicationID)
		}
	}
	sort.Strings(ids)
	return ids
}

func (r *multiExecutorPublicationRegistry) activeCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	active := 0
	for _, publication := range r.publications {
		if publication.Enabled || publication.PublicationID != "" {
			active++
		}
	}
	return active
}

func (r *multiExecutorPublicationRegistry) state() map[string]provideroperations.Publication {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := make(map[string]provideroperations.Publication, len(r.publications))
	for publicationID, publication := range r.publications {
		state[publicationID] = publication
	}
	return state
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func equalPublicationStates(left, right map[string]provideroperations.Publication) bool {
	if len(left) != len(right) {
		return false
	}
	for publicationID, publication := range left {
		if right[publicationID] != publication {
			return false
		}
	}
	return true
}
