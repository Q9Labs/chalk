package migrations

import "embed"

// Files is the immutable migration set shipped in the API and migrator images.
//
//go:embed *.sql
var Files embed.FS

<<<<<<< HEAD
const LatestVersion int64 = 20261127110000
||||||| 46e7acad9
const LatestVersion int64 = 20261127100000
=======
const LatestVersion int64 = 20261127130000
>>>>>>> origin/master
