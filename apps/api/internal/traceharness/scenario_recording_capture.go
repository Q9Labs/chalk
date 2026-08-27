package traceharness

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
)

const ServiceRecordingCaptureLifecycleScenario = "service:recording-capture-lifecycle"

func runServiceRecordingCaptureLifecycle(ctx context.Context) (ScenarioResult, error) {
	if err := ctx.Err(); err != nil {
		return ScenarioResult{}, err
	}

	now := deterministicClock()
	recorder := NewRecorder(now)
	envelopeDigest := sha256.Sum256([]byte("trace-recording-capture-envelope"))
	digestPrefix := hex.EncodeToString(envelopeDigest[:4])
	authority := map[string]any{
		"capture_epoch":          7,
		"attempt_count":          2,
		"fencing_generation":     4,
		"envelope_digest_prefix": digestPrefix,
		"lease_owner":            "recorder-trace-worker",
		"lease_state":            "live_at_attempt",
		"lease_ttl_seconds":      300,
	}

	authorize := recorder.Start("service", "recording.capture_attempt.authorize", "validate the server-issued capture attempt before touching the managed SFU", authority)
	authorize.End("capture attempt authority accepted", map[string]any{
		"provider":        "cf_sfu",
		"media_plane":     "chalk_managed",
		"authority":       "live_lease_fenced",
		"secret_material": "not_loaded",
	}, nil)

	recorder.Add("resolver", "mediaplaneproviders.Registry.Resolve", "resolve the deployment default media plane", map[string]any{
		"configuration_source": "deployment_default",
		"mode":                 "chalk_managed",
		"outcome":              "resolved",
		"provider":             "cf_sfu",
	})

	createConnection := recorder.Start("adapter", "cloudflare.sfu.capture.create_connection", "create the recorder-owned Cloudflare SFU capture connection", map[string]any{
		"provider":        "cf_sfu",
		"authority_scope": "recording_capture",
		"remote_media":    "provider_managed",
	})
	createConnection.End("Cloudflare SFU capture connection established", map[string]any{
		"connection": "opaque_provider_reference",
		"outcome":    "ready_for_rtp",
	}, nil)

	key := recorder.Start("control-plane", "POST /internal/v1/recorder/keys/access", "broker the epoch-scoped recording data key through AWS KMS GenerateDataKey", map[string]any{
		"authority":              "live_lease_fenced",
		"capture_epoch":          authority["capture_epoch"],
		"envelope_digest_prefix": digestPrefix,
		"provider":               "aws_kms",
		"plaintext":              "never_recorded",
	})
	key.End("recording data key access granted", map[string]any{
		"key_scope":                "recording_capture_epoch",
		"kms_operation":            "GenerateDataKey",
		"ciphertext_digest_prefix": "a1b2c3d4",
		"plaintext":                "worker_memory_only",
	}, nil)

	ready := recorder.Start("control-plane", "POST /internal/v1/recorder/capture/ready", "publish the durable capture-ready transition after the first RTP packet or the no-publisher grace period", map[string]any{
		"request_key": "capture_ready_trace_recording_7",
		"payload":     "recording_id,start_operation_id,capture_epoch",
		"trace":       "journey_and_w3c_context_propagated",
	})
	ready.End("recording_capture_ready operation pending", map[string]any{
		"operation":  "recording_capture_ready",
		"state":      "pending",
		"idempotent": true,
	}, nil)

	reserve := recorder.Start("control-plane", "POST /internal/v1/recorder/bundles/reserve", "allocate the next server-owned bundle sequence and object key", map[string]any{
		"authority":       "live_lease_fenced",
		"sequence_source": "server",
		"object_key":      "server_owned",
	})
	reserve.End("recording bundle allocation reserved", map[string]any{
		"sequence":           1,
		"allocation_version": 12,
		"reservation":        "opaque_reservation",
	}, nil)

	recorder.Add("worker", "recording.bundle.encrypt", "encrypt the canonical bundle before leaving worker memory", map[string]any{
		"schema":       "recording_bundle.v1",
		"content_type": "application/vnd.chalk.recording-bundle+json",
		"plaintext":    "cleared_after_encryption",
	})

	finalize := recorder.Start("control-plane", "POST /internal/v1/recorder/bundles/finalize", "bind encrypted bundle facts to the reserved allocation", map[string]any{
		"authority":          "live_lease_fenced",
		"allocation_version": 12,
		"checksum":           "sha256",
	})
	finalize.End("recording bundle upload authorized", map[string]any{
		"upload":       "scoped_signed_url",
		"worker_mtls":  "not_sent_to_object_storage",
		"content_type": "application/vnd.chalk.recording-bundle+json",
	}, nil)

	upload := recorder.Start("object-storage", "PUT R2 recording bundle", "upload encrypted bytes with the scoped object token", map[string]any{
		"provider":    "cloudflare_r2",
		"body":        "encrypted_bundle_only",
		"conditional": "if-none-match:*",
		"worker_mtls": "absent",
	})
	upload.End("encrypted recording bundle stored", map[string]any{
		"object_facts": "version_etag_checksum_size",
		"outcome":      "uploaded",
	}, nil)

	commit := recorder.Start("control-plane", "POST /internal/v1/recorder/bundles/commit", "HEAD the object and atomically commit verified bundle metadata", map[string]any{
		"authority":        "live_lease_fenced",
		"object_facts":     "provider_head_required",
		"manifest_binding": "exact_digest",
	})
	commit.End("recording bundle committed", map[string]any{
		"state":  "committed",
		"object": "authoritative_metadata_indexed",
	}, nil)

	stopped := recorder.Start("control-plane", "POST /internal/v1/recorder/capture/stopped", "publish the durable capture-stopped transition to Sync", map[string]any{
		"request_key": "capture_stopped_trace_recording_7",
		"payload":     "recording_id,stop_operation_id,capture_epoch",
		"trace":       "journey_and_w3c_context_propagated",
	})
	stopped.End("recording_capture_stopped operation pending", map[string]any{
		"operation":  "recording_capture_stopped",
		"state":      "pending",
		"idempotent": true,
	}, nil)

	fenceErr := errors.New("recording capture lifecycle authority mismatch")
	fence := recorder.Start("expected-failure", "recording.capture_attempt.fence", "exercise the live lease fence by submitting one stale replacement attempt", map[string]any{
		"attempt_count":       1,
		"fencing_generation":  3,
		"expected_generation": authority["fencing_generation"],
		"signal":              "authority_mismatch",
	})
	fence.End("expected stale capture callback rejected", map[string]any{
		"failure_class": "fenced_stale_attempt",
		"expected":      true,
		"retry":         "reclaim_current_lease",
	}, fenceErr)

	return directResult(ServiceRecordingCaptureLifecycleScenario, http.StatusOK, recorder, map[string]any{
		"provider":            "cf_sfu",
		"media_plane":         "chalk_managed",
		"bundle_state":        "committed",
		"capture_ready":       "published",
		"capture_stopped":     "published",
		"stale_attempt":       "rejected",
		"failure_signal":      "authority_mismatch",
		"expected_fence":      "exercised",
		"plaintext_persisted": false,
	}, nil)
}
