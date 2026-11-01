package transcripts

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"golang.org/x/text/language"
	"golang.org/x/text/language/display"
)

type TextMetadata struct {
	SpaceTitle string
	StartedAt  time.Time
	Duration   time.Duration
	Languages  []string
}

// FormatText renders the validated reader projection, never provider metadata.
// Equal start times retain artifact order; a five-second gap still merges.
func FormatText(document Document, metadata TextMetadata) string {
	var output strings.Builder
	duration := fmt.Sprintf("%d sec", int64(metadata.Duration/time.Second))
	if metadata.Duration >= time.Minute {
		duration = fmt.Sprintf("%d min", int64(metadata.Duration.Round(time.Minute)/time.Minute))
	}
	fmt.Fprintf(&output, "%s · %s · %s\n", metadata.SpaceTitle, metadata.StartedAt.UTC().Format("2 Jan 2006"), duration)
	languages := slices.Clone(metadata.Languages)
	if document.Language != nil {
		languages = append(languages, *document.Language)
	}
	seen := make(map[language.Tag]bool)
	var languageNames []string
	for _, value := range languages {
		tag, err := language.Parse(value)
		if err == nil && tag != language.Und && !seen[tag] {
			seen[tag] = true
			languageNames = append(languageNames, display.English.Languages().Name(tag))
		}
	}
	if len(languageNames) > 0 {
		slices.Sort(languageNames)
		fmt.Fprintf(&output, "Languages: %s\n", strings.Join(languageNames, ", "))
	}
	output.WriteByte('\n')
	if len(document.Cues) == 0 {
		output.WriteString("No speech was transcribed.\n")
		return output.String()
	}
	cues := slices.Clone(document.Cues)
	slices.SortStableFunc(cues, func(a, b DocumentCue) int {
		if a.StartMS < b.StartMS {
			return -1
		}
		if a.StartMS > b.StartMS {
			return 1
		}
		return 0
	})
	type speaker struct {
		ref        string
		generation int64
	}
	names := make(map[speaker]string)
	var previous speaker
	var endMS int64
	for index, cue := range cues {
		identity := speaker{cue.Identity.ParticipantRef, cue.Identity.ParticipantGeneration}
		fallback, ok := names[identity]
		if !ok {
			fallback = fmt.Sprintf("Speaker %d", len(names)+1)
			names[identity] = fallback
		}
		name := fallback
		if cue.Identity.DisplayName != nil && strings.TrimSpace(*cue.Identity.DisplayName) != "" {
			name = *cue.Identity.DisplayName
		}
		if index > 0 && identity == previous && cue.StartMS-endMS <= 5000 {
			output.WriteByte(' ')
		} else {
			if index > 0 {
				output.WriteByte('\n')
			}
			seconds := cue.StartMS / 1000
			fmt.Fprintf(&output, "[%02d:%02d:%02d] %s: ", seconds/3600, seconds/60%60, seconds%60, name)
			endMS = cue.EndMS
		}
		output.WriteString(cue.Text)
		previous = identity
		endMS = max(endMS, cue.EndMS)
	}
	output.WriteByte('\n')
	return output.String()
}
