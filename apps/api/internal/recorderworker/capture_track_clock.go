package recorderworker

import (
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

const captureClockCorrectionThresholdMS = int64(250)

// Reports distinguish a rewritten RTP clock from late transport delivery:
// transport jitter changes arrival time, not the sender's NTP/RTP mapping.
type captureTrackClock struct {
	sequence             rtpSequenceExtender
	baseTS               uint32
	baseMS               int64
	ssrc                 uint32
	started              bool
	highestTS            uint32
	highestTicks         int64
	reportStarted        bool
	reportSSRC           uint32
	reportBaseNTP        uint64
	reportLastNTP        uint64
	reportLastTS         uint32
	reportTicks          int64
	reportFloorMS        int64
	candidateNTP         uint64
	candidateMS          int64
	pendingCorrectionMS  int64
	correctionMS         int64
	largestCorrectionMS  int64
	floorCorrectionMS    int64
	arrivalWindowMS      int64
	arrivalWindowMinMS   int64
	previousArrivalMinMS int64
	corrections          []captureClockCorrection
}

type captureClockCorrection struct {
	ticks        int64
	sequence     uint64
	milliseconds int64
}

func captureNTPMilliseconds(delta uint64) int64 {
	return int64(delta>>32)*1000 + int64(((delta&0xffffffff)*1000)>>32)
}

func (c *captureTrackClock) observeSenderReport(report *rtcp.SenderReport, kind captureplane.TrackKind) {
	if report.NTPTime == 0 || (c.started && report.SSRC != c.ssrc) {
		return
	}
	if !c.reportStarted || c.reportSSRC != report.SSRC {
		c.reportStarted = true
		c.reportSSRC = report.SSRC
		c.reportBaseNTP = report.NTPTime
		c.reportLastNTP = report.NTPTime
		c.reportLastTS = report.RTPTime
		c.reportTicks = 0
		c.candidateNTP = 0
		return
	}
	if report.NTPTime <= c.reportLastNTP {
		return
	}
	c.reportTicks += int64(int32(report.RTPTime - c.reportLastTS))
	c.reportLastTS = report.RTPTime
	c.reportLastNTP = report.NTPTime
	skew := captureNTPMilliseconds(report.NTPTime-c.reportBaseNTP) - c.reportTicks*1000/captureClockRate(kind)
	if c.correctionMS == 0 {
		c.reportFloorMS = min(c.reportFloorMS, skew)
	}
	skew -= c.reportFloorMS
	// Provider reports can extrapolate a resumed layer incorrectly for three
	// seconds. Require four seconds of skew plus the packet minima below;
	// neither arrival jitter nor report extrapolation alone suffices.
	if skew-c.correctionMS < captureClockCorrectionThresholdMS {
		c.candidateNTP = 0
		c.pendingCorrectionMS = c.correctionMS
		return
	}
	if c.candidateNTP == 0 || skew < c.candidateMS-100 {
		c.candidateNTP = report.NTPTime
		c.candidateMS = skew
		return
	}
	c.candidateMS = min(c.candidateMS, skew)
	if captureNTPMilliseconds(report.NTPTime-c.candidateNTP) >= 4000 {
		c.pendingCorrectionMS = max(c.pendingCorrectionMS, c.candidateMS)
		c.candidateNTP = 0
	}
}

func (c *captureTrackClock) normalize(packet *rtp.Packet, kind captureplane.TrackKind, arrivalMS int64) (int64, uint32) {
	rate := captureClockRate(kind)
	extended := c.sequence.Extend(packet.SequenceNumber)
	if !c.started {
		c.started = true
		c.ssrc = packet.SSRC
		if c.reportStarted && c.reportSSRC != packet.SSRC {
			c.reportStarted = false
		}
		c.baseTS = packet.Timestamp
		c.highestTS = packet.Timestamp
		c.baseMS = arrivalMS
		c.arrivalWindowMS = arrivalMS
		// Nothing before the first picture belongs to this track's media span.
		c.reportBaseNTP = c.reportLastNTP
		c.reportTicks = 0
		c.candidateNTP = 0
		c.pendingCorrectionMS = 0
		return c.baseMS, uint32(c.baseMS * rate / 1000)
	}
	ticks := max(int64(0), c.highestTicks+int64(int32(packet.Timestamp-c.highestTS)))
	if ticks > c.highestTicks {
		c.highestTicks = ticks
		c.highestTS = packet.Timestamp
		rawLag := arrivalMS - (c.baseMS + ticks*1000/rate)
		if arrivalMS-c.arrivalWindowMS >= 1000 {
			c.previousArrivalMinMS = c.arrivalWindowMinMS
			c.arrivalWindowMS = arrivalMS
			c.arrivalWindowMinMS = rawLag
		} else {
			c.arrivalWindowMinMS = min(c.arrivalWindowMinMS, rawLag)
		}
		// Forwarders can extrapolate a temporarily paused sender in reports.
		// Received pictures must corroborate a sustained deficit too; minima
		// bound the shift without using a late packet's peak arrival lag.
		correction := min(c.pendingCorrectionMS, c.previousArrivalMinMS, c.arrivalWindowMinMS)
		if correction-c.correctionMS >= captureClockCorrectionThresholdMS {
			c.largestCorrectionMS = max(c.largestCorrectionMS, correction-c.correctionMS)
			c.correctionMS = correction
			c.corrections = append(c.corrections, captureClockCorrection{ticks: ticks, sequence: extended, milliseconds: c.correctionMS})
		}
	}
	// Keep the old mapping for late packets of a picture already recorded.
	// Prune only mappings wholly outside packet admission's reorder window.
	for len(c.corrections) > 1 && c.sequence.highest >= c.corrections[1].sequence && c.sequence.highest-c.corrections[1].sequence >= uint64(len((capturePacketWindow{}).seen)) {
		c.floorCorrectionMS = c.corrections[0].milliseconds
		c.corrections = c.corrections[1:]
	}
	correction := c.floorCorrectionMS
	for i := len(c.corrections) - 1; i >= 0; i-- {
		if ticks >= c.corrections[i].ticks {
			correction = c.corrections[i].milliseconds
			break
		}
	}
	media := c.baseMS + ticks*1000/rate + correction
	timestamp := uint32(c.baseMS*rate/1000) + uint32(ticks) + uint32(correction*rate/1000)
	return media, timestamp
}

func captureClockRate(kind captureplane.TrackKind) int64 {
	if kind == captureplane.TrackKindAudio {
		return 48000
	}
	return 90000
}
