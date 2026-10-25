package recordingpipeline

// AdmissionLimits bounds the fleet's concurrent reservations, not each Recording.
type AdmissionLimits struct {
	RecordingCap   int
	ParticipantCap int
}

func (l AdmissionLimits) WithDefaults() AdmissionLimits {
	if l.RecordingCap == 0 {
		l.RecordingCap = MaximumEpisodes
	}
	if l.ParticipantCap == 0 {
		l.ParticipantCap = MaximumParticipants
	}
	return l
}

func (l AdmissionLimits) BitrateCapBPS() int64 {
	return int64(l.WithDefaults().RecordingCap) * MaximumInputBitrateBPS
}
