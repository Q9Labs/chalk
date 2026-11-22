/** An attachment that could not load, with the way to load it again. */
export function UnavailableAttachment({ fileName, onTryAgain }: { readonly fileName: string; readonly onTryAgain: () => void }) {
  return (
    <div className="call-file">
      <span>
        <b dir="auto">{fileName}</b>
        <small>Attachment unavailable</small>
      </span>
      <button type="button" aria-label={`Load ${fileName} again`} onClick={onTryAgain}>
        Try again
      </button>
    </div>
  );
}
