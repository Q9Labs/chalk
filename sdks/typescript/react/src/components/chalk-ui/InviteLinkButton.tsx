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
 * The one way to grab the invite link. `menu` is a row in the call menu; `card` is the filled button on the invite card.
 * The label never changes: the copy icon morphs to a check and back, and a polite live region says "Link copied".
 */
export function InviteLinkButton({ link, variant }: { readonly link: string; readonly variant: "menu" | "card" }) {
  const { copied, error, copy } = useCopyText(link);
  return (
    <>
      <button type="button" data-part="copy-invite-link" data-variant={variant} data-copied={copied} className="chalk-invite-link" onClick={() => void copy()}>
        <span className="chalk-invite-link-lead">
          <MenuIcon name="link" />
        </span>
        <span className="chalk-invite-link-label">Copy invite link</span>
        {variant === "menu" ? (
          <span dir="ltr" className="chalk-invite-link-slug">
            {inviteSlug(link)}
          </span>
        ) : null}
        <span className="chalk-invite-link-end">
          <CopyMorphIcon copied={copied} size={variant === "menu" ? 16 : 18} />
        </span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {error ? "Could not copy. Try again." : copied ? "Link copied" : ""}
      </span>
    </>
  );
}
