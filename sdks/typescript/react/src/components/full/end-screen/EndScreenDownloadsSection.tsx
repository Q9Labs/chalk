import { Download01Icon, FileTextIcon, Video01Icon } from "../../../utils/icons";
import { IconButton } from "../../atomic";

interface EndScreenDownloadsSectionProps {
  hasRecording: boolean;
  hasTranscription: boolean;
  onDownloadRecording: () => void;
  onDownloadTranscription?: (format: "txt" | "srt" | "vtt") => void;
}

export function EndScreenDownloadsSection({ hasRecording, hasTranscription, onDownloadRecording, onDownloadTranscription }: EndScreenDownloadsSectionProps) {
  if (!hasRecording && !hasTranscription) {
    return null;
  }

  return (
    <div className="border-t border-[var(--border)] p-6 space-y-4 bg-[var(--muted)]/30">
      {hasRecording && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-md bg-[var(--accent)]/10 text-[var(--accent)]">
              <Video01Icon size={18} />
            </div>
            <div className="text-sm">
              <p className="font-medium">Recording ready</p>
              <p className="text-[var(--muted-foreground)] text-xs">MP4 format</p>
            </div>
          </div>
          <IconButton icon={<Download01Icon size={18} />} onClick={onDownloadRecording} aria-label="Download Recording" variant="outline" size="sm" />
        </div>
      )}

      {hasTranscription && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-md bg-[var(--success)]/10 text-[var(--success)]">
              <FileTextIcon size={18} />
            </div>
            <div className="text-sm">
              <p className="font-medium">Transcription</p>
              <p className="text-[var(--muted-foreground)] text-xs">Available formats</p>
            </div>
          </div>
          <div className="flex gap-1">
            {["txt", "srt", "vtt"].map((format) => (
              <button key={format} type="button" onClick={() => onDownloadTranscription?.(format as "txt" | "srt" | "vtt")} className="px-2 py-1 text-xs font-medium uppercase rounded border border-[var(--border)] hover:bg-[var(--muted)] transition-colors">
                {format}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
