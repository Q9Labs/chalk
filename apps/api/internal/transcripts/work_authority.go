package transcripts

import "time"

// WorkLeaseDuration also bounds presigned worker PUT authorities. A completed
// job may clear its lease before the previously issued URL actually expires.
const WorkLeaseDuration = 15 * time.Minute
