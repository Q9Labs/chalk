package transcripts

import (
	"cmp"
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
	fmt.Fprintf(&output, "%s · %s · %s\n", metadata.SpaceTitle, metadata.StartedAt.UTC().Format("2 Jan 2006"), formatTextDuration(metadata.Duration))
	if names := languageNames(metadata.Languages, document.Language); len(names) > 0 {
		fmt.Fprintf(&output, "Languages: %s\n", strings.Join(names, ", "))
	}
	output.WriteByte('\n')
	if len(document.Cues) == 0 {
		output.WriteString("No speech was transcribed.\n")
		return output.String()
	}
	cues := slices.Clone(document.Cues)
	slices.SortStableFunc(cues, func(a, b DocumentCue) int { return cmp.Compare(a.StartMS, b.StartMS) })
	writeTextCues(&output, cues)
	output.WriteByte('\n')
	return output.String()
}

func formatTextDuration(duration time.Duration) string {
	if duration >= time.Minute {
		return fmt.Sprintf("%d min", int64(duration.Round(time.Minute)/time.Minute))
	}
	return fmt.Sprintf("%d sec", int64(duration/time.Second))
}

func languageNames(languages []string, documentLanguage *string) []string {
	languages = slices.Clone(languages)
	if documentLanguage != nil {
		languages = append(languages, *documentLanguage)
	}
	seen := make(map[language.Tag]bool)
	var names []string
	for _, value := range languages {
		tag, err := language.Parse(value)
		if err != nil || tag == language.Und || seen[tag] {
			continue
		}
		seen[tag] = true
		names = append(names, display.English.Languages().Name(tag))
	}
	slices.Sort(names)
	return names
}

type textSpeaker struct {
	ref        string
	generation int64
}

func writeTextCues(output *strings.Builder, cues []DocumentCue) {
	fallbacks := make(map[textSpeaker]string)
	var previous textSpeaker
	var endMS int64
	for index, cue := range cues {
		speaker := textSpeaker{cue.Identity.ParticipantRef, cue.Identity.ParticipantGeneration}
		name := speakerLabel(fallbacks, speaker, cue.Identity.DisplayName)
		if index > 0 && speaker == previous && cue.StartMS-endMS <= 5000 {
			output.WriteByte(' ')
		} else {
			if index > 0 {
				output.WriteByte('\n')
			}
			seconds := cue.StartMS / 1000
			fmt.Fprintf(output, "[%02d:%02d:%02d] %s: ", seconds/3600, seconds/60%60, seconds%60, name)
			endMS = cue.EndMS
		}
		output.WriteString(cue.Text)
		previous = speaker
		endMS = max(endMS, cue.EndMS)
	}
}

// speakerLabel numbers every speaker in order of first appearance, even those
// whose display name wins, so fallback numbers stay stable.
func speakerLabel(fallbacks map[textSpeaker]string, speaker textSpeaker, displayName *string) string {
	fallback, ok := fallbacks[speaker]
	if !ok {
		fallback = fmt.Sprintf("Speaker %d", len(fallbacks)+1)
		fallbacks[speaker] = fallback
	}
	if displayName != nil && strings.TrimSpace(*displayName) != "" {
		return *displayName
	}
	return fallback
}
