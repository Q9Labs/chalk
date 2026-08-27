// Package capturesignaling owns the durable, provider-neutral command queue
// for a recorder's CapturePlane connection.
//
// A command is prepared from immutable recorder-job authority and a typed
// CapturePlane input. Its canonical request bytes and SHA-256 fingerprint are
// stored before the provider is called. One persistence claim serializes all
// commands for a signaling handle, and an exact completed result is replayed
// on retry.
package capturesignaling
