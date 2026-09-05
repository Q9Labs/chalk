package mediaplane

import "errors"

type RemoteTrackIdentity struct {
	ConnectionID string
	TrackName    string
}

type remoteTrackAbsenceError interface {
	MissingRemoteTracks() []RemoteTrackIdentity
}

type exactRemoteTrackAbsenceError interface {
	ExactRemoteTrackAbsence() bool
}

type partialRemoteTrackResponseError interface {
	PartialRemoteTrackResponse() bool
}

func MissingRemoteTracks(err error) []RemoteTrackIdentity {
	if err == nil {
		return nil
	}

	var absence remoteTrackAbsenceError
	if !errors.As(err, &absence) {
		return nil
	}

	identities := absence.MissingRemoteTracks()
	if len(identities) == 0 {
		return nil
	}
	return append([]RemoteTrackIdentity(nil), identities...)
}

func IsExactRemoteTrackAbsence(err error) bool {
	if err == nil {
		return false
	}

	var absence exactRemoteTrackAbsenceError
	return errors.As(err, &absence) && absence.ExactRemoteTrackAbsence()
}

func IsPartialRemoteTrackResponse(err error) bool {
	if err == nil {
		return false
	}

	var partial partialRemoteTrackResponseError
	return errors.As(err, &partial) && partial.PartialRemoteTrackResponse()
}
