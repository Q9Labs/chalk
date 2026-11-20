package media

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/obs"
)

func (s *Session) audioFact(event, claim string, publication *publication, peer string, sampleMs int64) {
	attrs := []slog.Attr{
		obs.F(obs.FieldTenantID, s.scope.TenantID),
		obs.F(obs.FieldEpisodeID, s.scope.EpisodeID),
		obs.F(obs.FieldParticipantID, s.scope.ParticipantID),
		obs.F(obs.FieldGeneration, s.scope.Generation),
		obs.F(obs.FieldMediaConnectionID, s.id),
		obs.F(obs.FieldAudioObservation, claim),
		obs.F(obs.FieldAudioSampleMs, sampleMs),
		obs.F(obs.FieldAudioTrackKey, fmt.Sprintf("%x", sha256.Sum256([]byte(publication.session.id+"\x00"+publication.name)))),
	}
	if peer != "" {
		attrs = append(attrs, obs.F(obs.FieldAudioPeerID, peer))
	}
	if trace := s.trace.Load(); trace != nil {
		if trace.TraceID != "" {
			attrs = append(attrs, obs.F(obs.FieldTraceID, trace.TraceID))
		}
		if trace.JourneyID != "" {
			attrs = append(attrs, obs.F(obs.FieldJourneyID, trace.JourneyID))
		}
	}
	obs.Fact(context.Background(), event, attrs...)
}

func (s *Session) traceMicrophoneIngress(pub *publication, packets, previous uint64, now int64) {
	elapsed := audioSampleElapsed(&pub.audioSampleAt, now)
	if elapsed == 0 || pub.held.Load() || packets < previous || s.scope.ParticipantID == "" {
		return
	}
	claim := "ingress_flat"
	if packets > previous {
		claim = "ingress_packets"
	}
	s.audioFact(obs.EventAudioSfuIngress, claim, pub, "", elapsed)
}

func (s *Session) traceMicrophoneForward(sub *subscription, now int64) {
	if sub.pub.source != "microphone" || s.scope.ParticipantID == "" {
		return
	}
	packets, attempts := sub.audioPackets.Load(), sub.audioAttempts.Load()
	previousPackets, previousAttempts := sub.audioStatsPackets, sub.audioStatsAttempts
	sub.audioStatsPackets, sub.audioStatsAttempts = packets, attempts
	elapsed := audioSampleElapsed(&sub.audioSampleAt, now)
	if elapsed == 0 || sub.closed.Load() || sub.pub.held.Load() {
		return
	}
	switch {
	case packets > previousPackets:
		s.audioFact(obs.EventAudioSfuForward, "forwarded", sub.pub, sub.pub.session.scope.ParticipantID, elapsed)
	case attempts > previousAttempts && sub.pub.authority.allows(now, now):
		s.audioFact(obs.EventAudioSfuForward, "ingress_not_forwarded", sub.pub, sub.pub.session.scope.ParticipantID, elapsed)
	default:
		s.audioFact(obs.EventAudioSfuForward, "forwarding_flat", sub.pub, sub.pub.session.scope.ParticipantID, elapsed)
	}
}

func audioSampleElapsed(previous *int64, now int64) int64 {
	elapsed := time.Duration(now - *previous).Milliseconds()
	sampled := *previous != 0
	*previous = now
	if !sampled || elapsed < 1000 || elapsed > 60_000 {
		return 0
	}
	return elapsed
}
