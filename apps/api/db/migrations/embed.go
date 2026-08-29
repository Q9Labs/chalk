package migrations

import "embed"

// Files is the immutable migration set shipped in the API and migrator images.
//
//go:embed *.sql
var Files embed.FS

const LatestVersion int64 = 20260829170000
