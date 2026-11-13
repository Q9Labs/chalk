import { Icon } from "../site/Icon";

/** A failure the page can't fix routes to support, with the page's link so they can find the session. */
export function ContactSupport({ problem, size }: { readonly problem: string; readonly size?: "sm" }) {
  const href = `mailto:support@chalkmeet.com?subject=${encodeURIComponent(problem)}&body=${encodeURIComponent(`Session: ${window.location.href}`)}`;
  return (
    <a className={size ? `btn sec ${size}` : "btn sec"} href={href}>
      <Icon name="chat" />
      Contact support
    </a>
  );
}
