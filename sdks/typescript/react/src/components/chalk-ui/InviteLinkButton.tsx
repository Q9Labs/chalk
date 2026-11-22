import { CopyMorphIcon } from "./ChalkCopyButton";
import { MenuIcon } from "./MenuIcon";
import { useCopyText } from "./useCopyText";

function inviteSlug(link: string): string {
  try {
    const { pathname, host } = new URL(link);
    return pathname.split("/").filter(Boolean).at(-1) ?? host;
  } catch {
    return link;
  }
}

/**
 * The one way to grab the invite link: a row in the call menu.
 * The label never changes: the copy icon morphs to a check and back, and a polite live region says "Link copied".
 */
export function InviteLinkButton({ link }: { readonly link: string }) {
  const { copied, error, copy } = useCopyText(link);
  return (
    <>
      <button type="button" data-part="copy-invite-link" data-copied={copied} className="chalk-invite-link" onClick={() => void copy()}>
        <span className="chalk-invite-link-lead">
          <MenuIcon name="link" />
        </span>
        <span className="chalk-invite-link-label">Copy invite link</span>
        <span dir="ltr" className="chalk-invite-link-slug">
          {inviteSlug(link)}
        </span>
        <span className="chalk-invite-link-end">
          <CopyMorphIcon copied={copied} size={16} />
        </span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {error ? "Could not copy. Try again." : copied ? "Link copied" : ""}
      </span>
    </>
  );
}
