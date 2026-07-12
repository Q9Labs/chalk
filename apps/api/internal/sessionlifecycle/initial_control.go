package sessionlifecycle

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
)

const (
	controlStateDigestPrefix = "chalk-sync-state-v2"
	controlStateSchemaV1     = int32(1)
	emptyControlProjection   = `{"control_revision":0,"participants":[],"state_schema_version":1,"status":"active"}`
)

// EmptyInitialControlState returns the schema-v1 authority state used when a
// Session is created. The projection and digest definition are shared with the
// generated sync-v2 contract; Session identity is deliberately outside the
// durable control projection.
func EmptyInitialControlState() InitialControlState {
	digestInput := make([]byte, 0, len(controlStateDigestPrefix)+5+len(emptyControlProjection))
	digestInput = append(digestInput, controlStateDigestPrefix...)
	digestInput = append(digestInput, 0)
	version := make([]byte, 4)
	binary.BigEndian.PutUint32(version, uint32(controlStateSchemaV1))
	digestInput = append(digestInput, version...)
	digestInput = append(digestInput, emptyControlProjection...)
	digest := sha256.Sum256(digestInput)

	wireSnapshot := fmt.Sprintf(
		`{"control_revision":0,"participants":[],"state_digest":"%s","state_schema_version":1,"status":"active"}`,
		hex.EncodeToString(digest[:]),
	)

	return InitialControlState{
		FoldedState:   []byte(emptyControlProjection),
		Digest:        digest,
		SchemaVersion: controlStateSchemaV1,
		SnapshotBytes: int64(len(wireSnapshot)),
	}
}
