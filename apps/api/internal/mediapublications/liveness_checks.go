package mediapublications

import (
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type publicationLivenessChecks struct {
	mu       sync.Mutex
	now      func() time.Time
	claimed  map[publicationCandidateKey]time.Time
	evidence map[listenerEvidenceKey]map[utilities.ID]listenerReport
}

type servedKey struct {
	tenantID  string
	episodeID string
	identity  RemoteTrackIdentity
}

type listenerEvidenceKey = servedKey

type listenerReport struct {
	connectionID string
	failing      bool
	firstFailed  time.Time
	updatedAt    time.Time
}

func newPublicationLivenessChecks(now func() time.Time) *publicationLivenessChecks {
	return &publicationLivenessChecks{
		now:      now,
		claimed:  make(map[publicationCandidateKey]time.Time),
		evidence: make(map[listenerEvidenceKey]map[utilities.ID]listenerReport),
	}
}

func (checks *publicationLivenessChecks) pruneEvidenceKeyLocked(key listenerEvidenceKey, now time.Time) {
	reports := checks.evidence[key]
	for listenerID, report := range reports {
		if now.Sub(report.updatedAt) >= publicationStillFailingWindow {
			delete(reports, listenerID)
		}
	}
	if len(reports) == 0 {
		delete(checks.evidence, key)
	}
}

func (checks *publicationLivenessChecks) sweepExpiredEvidenceLocked(now time.Time) {
	for key := range checks.evidence {
		checks.pruneEvidenceKeyLocked(key, now)
	}
}

func (checks *publicationLivenessChecks) reportForWriteLocked(key listenerEvidenceKey, listenerID utilities.ID, now time.Time) map[utilities.ID]listenerReport {
	checks.pruneEvidenceKeyLocked(key, now)
	reports, exists := checks.evidence[key]
	if !exists {
		if len(checks.evidence) >= publicationLivenessEvidenceMaxKeys {
			checks.sweepExpiredEvidenceLocked(now)
			if len(checks.evidence) >= publicationLivenessEvidenceMaxKeys {
				for candidate := range checks.evidence {
					delete(checks.evidence, candidate)
					break
				}
			}
		}
		reports = make(map[utilities.ID]listenerReport)
		checks.evidence[key] = reports
	}
	if _, exists := reports[listenerID]; !exists && len(reports) >= 64 {
		var oldestID utilities.ID
		var oldest time.Time
		for candidate, report := range reports {
			if oldestID.IsZero() || report.updatedAt.Before(oldest) {
				oldestID, oldest = candidate, report.updatedAt
			}
		}
		delete(reports, oldestID)
	}
	return reports
}

func (checks *publicationLivenessChecks) recordFailure(key listenerEvidenceKey, listenerID utilities.ID, connectionID string) {
	if checks == nil || listenerID.IsZero() {
		return
	}
	checks.mu.Lock()
	defer checks.mu.Unlock()
	now := checks.now()
	reports := checks.reportForWriteLocked(key, listenerID, now)
	report, exists := reports[listenerID]
	if exists && report.failing && report.connectionID == connectionID && now.Sub(report.updatedAt) < publicationStillFailingWindow {
		report.updatedAt = now
		reports[listenerID] = report
		return
	}
	reports[listenerID] = listenerReport{connectionID: connectionID, failing: true, firstFailed: now, updatedAt: now}
}

func (checks *publicationLivenessChecks) recordServed(key listenerEvidenceKey, listenerID utilities.ID, connectionID string) {
	if checks == nil || listenerID.IsZero() {
		return
	}
	checks.mu.Lock()
	defer checks.mu.Unlock()
	now := checks.now()
	reports := checks.reportForWriteLocked(key, listenerID, now)
	reports[listenerID] = listenerReport{connectionID: connectionID, updatedAt: now}
}

// withdrawDue reports whether listeners have failed to pull an active track for longer than
// the grace period. It also returns how long the oldest counted failure has lasted.
func (checks *publicationLivenessChecks) withdrawDue(key listenerEvidenceKey, present map[utilities.ID]string) (bool, time.Duration) {
	if checks == nil {
		return false, 0
	}
	checks.mu.Lock()
	defer checks.mu.Unlock()
	now := checks.now()
	checks.pruneEvidenceKeyLocked(key, now)
	reports := checks.evidence[key]
	failing, served := 0, 0
	var failingFor time.Duration
	for listenerID, report := range reports {
		connectionID, isPresent := present[listenerID]
		if !isPresent || connectionID == "" || report.connectionID == "" || connectionID != report.connectionID {
			continue
		}
		if report.failing {
			failing++
			failingFor = max(failingFor, now.Sub(report.firstFailed))
		} else {
			served++
		}
	}
	return failingFor >= publicationActiveTrackGrace && (failing >= 2 || served == 0), failingFor
}

func (checks *publicationLivenessChecks) forget(candidate publicationCandidate) {
	if checks == nil {
		return
	}
	checks.mu.Lock()
	defer checks.mu.Unlock()
	delete(checks.evidence, servedKey{
		tenantID:  candidate.key.tenantID,
		episodeID: candidate.key.episodeID,
		identity:  candidate.identity,
	})
}

func (checks *publicationLivenessChecks) claim(key publicationCandidateKey) bool {
	checks.mu.Lock()
	defer checks.mu.Unlock()
	now := checks.now()
	for candidate, claimedAt := range checks.claimed {
		if now.Sub(claimedAt) >= publicationLivenessDedupeWindow {
			delete(checks.claimed, candidate)
		}
	}
	if claimedAt, ok := checks.claimed[key]; ok && now.Sub(claimedAt) < publicationLivenessDedupeWindow {
		return false
	}
	checks.claimed[key] = now
	return true
}
