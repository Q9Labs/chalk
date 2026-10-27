import { Dither } from "../landing/Dither";
import { GITHUB_URL, SIGN_IN_HREF, START_CALL_HREF } from "./links";
import { Lockup } from "./Lockup";

export function SiteFooter({ dither = false }: { readonly dither?: boolean }) {
  return (
    <footer className={dither ? "foot dither-footer" : "foot"}>
      {dither ? <Dither kind="footer" /> : null}
      <div className="ctn">
        <div className="top">
          <div className="brand">
            <Lockup />
            <p>Video calls that keep their link, for your team or inside your product.</p>
          </div>
          <nav aria-labelledby="foot-product">
            <h3 id="foot-product">Product</h3>
            <ul>
              <li>
                <a href={START_CALL_HREF}>Start a call</a>
              </li>
              <li>
                <a href={SIGN_IN_HREF}>Sign in</a>
              </li>
              <li>
                <a href="/#speed">Speed</a>
              </li>
            </ul>
          </nav>
          <nav aria-labelledby="foot-developers">
            <h3 id="foot-developers">Developers</h3>
            <ul>
              <li>
                <a href="/docs">Docs</a>
              </li>
              <li>
                <a href="/docs/quickstart">Quickstart</a>
              </li>
              <li>
                <a href="/docs/webhooks">Webhooks</a>
              </li>
              <li>
                <a href={GITHUB_URL}>GitHub</a>
              </li>
            </ul>
          </nav>
        </div>
        <div className="legal">
          <span>© 2026 Q9 Labs</span>
          <a href={`${GITHUB_URL}/blob/master/LICENSE`}>MIT license</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </div>
      </div>
    </footer>
  );
}
