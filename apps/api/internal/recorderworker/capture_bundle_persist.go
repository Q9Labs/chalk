package recorderworker

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func (w *captureBundleWriter) addTerminalGap(now time.Time) error {
	storageCtx, cancel := context.WithTimeout(context.Background(), w.attempt.config.CloseTimeout)
	defer cancel()
	return w.addTerminalGapWithContext(storageCtx, now)
}

func (w *captureBundleWriter) addTerminalGapWithContext(ctx context.Context, now time.Time) error {
	if w.terminalGap || w.origin.IsZero() {
		return nil
	}
	endMono := w.relative(now)
	if endMono < w.lastMono {
		endMono = w.lastMono
	}
	endMedia := w.relative(now)
	if endMedia < w.lastMedia {
		endMedia = w.lastMedia
	}
	if endMono == 0 && endMedia == 0 && w.lastMono == 0 && w.lastMedia == 0 {
		// A capture that starts and stops within one clock millisecond still needs
		// a positive recording-relative duration for completion and replay.
		endMono, endMedia = 1, 1
	}
	if w.assembler != nil {
		if err := w.closeCurrentBundle(ctx, recordingbundle.CloseReasonExplicit); err != nil {
			return err
		}
	}
	if err := w.appendGapUntil(ctx, endMono, endMedia, true); err != nil {
		return err
	}
	w.terminalGap = true
	return nil
}

func (w *captureBundleWriter) closeWithContext(ctx context.Context, reason recordingbundle.CloseReason, now time.Time) error {
	if err := w.addTerminalGapWithContext(ctx, now); err != nil {
		return err
	}
	if w.assembler != nil {
		if !w.assembler.Closed() {
			endMono, endMedia := w.controlEventClocks(now)
			if w.terminalGap {
				endMono, endMedia = w.lastMono, w.lastMedia
			}
			if err := w.assembler.Close(reason, endMono, endMedia); err != nil && !errors.Is(err, recordingbundle.ErrEmptyBundle) {
				return err
			}
		}
		if w.assembler.Closed() {
			if err := w.persist(ctx); err != nil {
				return err
			}
		}
	}
	if len(w.pendingGaps) > 0 {
		if err := w.ensureAssembler(ctx); err != nil {
			return err
		}
		endMono, endMedia := w.controlEventClocks(now)
		if w.terminalGap {
			endMono, endMedia = w.lastMono, w.lastMedia
		}
		if err := w.assembler.Close(reason, endMono, endMedia); err != nil {
			return err
		}
		if err := w.persist(ctx); err != nil {
			return err
		}
	}
	clear(w.key)
	w.key = nil
	clear(w.contextDigest)
	w.contextDigest = nil
	return nil
}

func (w *captureBundleWriter) persist(ctx context.Context) error {
	if w.assembler == nil {
		return nil
	}
	sealed, err := w.assembler.Seal()
	if err != nil {
		return err
	}
	if w.key == nil {
		return fmt.Errorf("%w: key unavailable", ErrInvalidCaptureAttempt)
	}
	bundle := sealed.Bundle
	pending := w.assembler.TakePendingGaps()
	w.pendingGaps = append(w.pendingGaps, pending...)
	if w.pendingObject != nil && (w.pendingObject.assembler != w.assembler || w.pendingObject.reservation != w.reservation.ReservationID) {
		recordingbundle.ClearSealedBundle(&sealed)
		return fmt.Errorf("%w: encrypted bundle retry identity mismatch", ErrInvalidCaptureAttempt)
	}
	if w.pendingObject == nil {
		encoded, err := recordingbundle.Encrypt(w.key, bundle)
		if err != nil {
			recordingbundle.ClearSealedBundle(&sealed)
			return err
		}
		w.pendingObject = &pendingCaptureObject{
			assembler:   w.assembler,
			reservation: w.reservation.ReservationID,
			body:        encoded,
			checksum:    recordingbundle.ObjectChecksumHex(encoded),
		}
	}
	encoded := w.pendingObject.body
	checksum := w.pendingObject.checksum
	contentType := captureBundleContentType
	if bundle.Version == recordingbundle.LegacyVersion {
		contentType = legacyCaptureBundleContentType
	}
	codec, layer := captureBundleCodecAndLayer(bundle)
	authority := w.bundleAuthority()
	if !w.pendingObject.finalized {
		upload, err := w.attempt.bundles.Finalize(ctx, CaptureBundleFinalize{Authority: authority, Reservation: w.reservation, Bundle: bundle, ObjectSize: int64(len(encoded)), ObjectSHA256: checksum, ContentType: contentType, Codec: codec, Layer: layer})
		if err != nil {
			recordingbundle.ClearSealedBundle(&sealed)
			return fmt.Errorf("finalize recording bundle: %w", err)
		}
		if upload.Reservation.ReservationID != w.reservation.ReservationID || strings.TrimSpace(upload.UploadToken) == "" {
			recordingbundle.ClearSealedBundle(&sealed)
			return fmt.Errorf("%w: finalized bundle authority mismatch", ErrInvalidCaptureAttempt)
		}
		w.pendingObject.upload = upload
		w.pendingObject.finalized = true
	}
	commit := func() error {
		return w.attempt.bundles.Commit(ctx, CaptureBundleCommit{Authority: authority, Reservation: w.reservation, UploadToken: w.pendingObject.upload.UploadToken, Bundle: bundle, ObjectSize: int64(len(encoded)), ObjectSHA256: checksum, ContentType: contentType})
	}
	if w.pendingObject.uploadAttempted {
		if err := commit(); err == nil {
			return w.finishPendingObject(&sealed)
		} else if !errors.Is(err, ErrControlPlaneRetryable) {
			recordingbundle.ClearSealedBundle(&sealed)
			return fmt.Errorf("resume recording bundle commit: %w", err)
		}
	}
	w.pendingObject.uploadAttempted = true
	if uploadErr := w.attempt.objects.Upload(ctx, CaptureObjectUpload{Upload: w.pendingObject.upload, Body: encoded, ContentType: contentType, Checksum: checksum}); uploadErr != nil {
		commitErr := commit()
		if commitErr == nil {
			return w.finishPendingObject(&sealed)
		}
		recordingbundle.ClearSealedBundle(&sealed)
		return fmt.Errorf("upload recording bundle: %w", errors.Join(uploadErr, commitErr))
	}
	if err := commit(); err != nil {
		recordingbundle.ClearSealedBundle(&sealed)
		return fmt.Errorf("commit recording bundle: %w", err)
	}
	return w.finishPendingObject(&sealed)
}

func (w *captureBundleWriter) finishPendingObject(sealed *recordingbundle.SealedBundle) error {
	recordingbundle.ClearSealedBundle(sealed)
	w.clearPendingObject()
	w.assembler = nil
	w.reservation = BundleReservation{}
	return nil
}

func (w *captureBundleWriter) clearPendingObject() {
	if w.pendingObject == nil {
		return
	}
	clear(w.pendingObject.body)
	w.pendingObject = nil
}

func (w *captureBundleWriter) clearTerminalState() {
	w.clearPendingObject()
	clear(w.key)
	w.key = nil
	clear(w.contextDigest)
	w.contextDigest = nil
	w.assembler = nil
	w.reservation = BundleReservation{}
	w.pendingGaps = nil
}

func (w *captureBundleWriter) bundleAuthority() BundleReserveRequest {
	lease := w.attempt.currentLease()
	return BundleReserveRequest{
		TenantID:                w.attempt.authority.TenantID.String(),
		SpaceID:                 w.attempt.authority.SpaceID.String(),
		EpisodeID:               w.attempt.authority.EpisodeID.String(),
		RecordingID:             w.attempt.authority.RecordingID.String(),
		JobID:                   w.attempt.authority.JobID.String(),
		ObjectHandle:            w.attempt.authority.Envelope.ObjectHandle,
		CaptureEpoch:            uint64(w.attempt.authority.CaptureEpoch),
		Attempt:                 w.attempt.authority.AttemptCount,
		FencingGeneration:       w.attempt.authority.FencingGeneration,
		LeaseOwner:              lease.Owner,
		LeaseToken:              lease.Token,
		LeaseExpiresAt:          lease.ExpiresAt,
		EnvelopeDigest:          hex.EncodeToString(w.attempt.authority.EnvelopeDigest),
		EncryptionContextDigest: append([]byte(nil), w.contextDigest...),
	}
}

func captureBundleCodecAndLayer(bundle recordingbundle.Bundle) (string, *string) {
	codecs := make(map[string]struct{})
	layers := make(map[string]struct{})
	for _, fragment := range bundle.Fragments {
		codecs[fragment.Track.Codec] = struct{}{}
		layers[fragment.Track.Layer] = struct{}{}
	}
	codecValues := make([]string, 0, len(codecs))
	for codec := range codecs {
		codecValues = append(codecValues, codec)
	}
	sort.Strings(codecValues)
	codec := "gap"
	if len(codecValues) > 0 {
		codec = strings.Join(codecValues, "+")
	}
	if len(layers) != 1 {
		return codec, nil
	}
	for layer := range layers {
		value := layer
		return codec, &value
	}
	return codec, nil
}
