import { SITE_ORIGIN } from "../../lib/site-origin";
import { Icon } from "../site/Icon";
import { Favicon, hostOf } from "./Favicon";

const DEVELOPMENT_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;

export function SitesPanel({ origins, onAdd, onRemove }: { readonly origins: readonly string[]; readonly onAdd: () => void; readonly onRemove: (origin: string) => void }) {
  const all = [SITE_ORIGIN, ...origins];
  return (
    <section className="panel card" id="websites" aria-labelledby="websites-title">
      <div className="ph">
        <Icon name="globe" size={18} />
        <div>
          <h2 id="websites-title">Allowed websites</h2>
          <div className="sub">Chalk calls can load inside these websites with this account’s keys.</div>
        </div>
        <span className="end">
          <button type="button" className="btn out" onClick={onAdd}>
            <Icon name="plus" size={16} />
            Add website
          </button>
        </span>
      </div>
      <div className="rows sites">
        {all.map((origin) => (
          <SiteRow key={origin} origin={origin} fixed={origin === SITE_ORIGIN} onRemove={onRemove} />
        ))}
      </div>
    </section>
  );
}

function SiteRow({ origin, fixed, onRemove }: { readonly origin: string; readonly fixed: boolean; readonly onRemove: (origin: string) => void }) {
  const host = hostOf(origin);
  const scheme = origin.startsWith("https://") ? "https://" : "http://";
  const port = origin.slice(scheme.length + host.length);
  return (
    <div className="row">
      <div className="o">
        <Favicon host={host} />
        <span className="ell">
          <span className="sc">{scheme}</span>
          <b>{host}</b>
          {port ? <span className="px">{port}</span> : null}
        </span>
      </div>
      {fixed ? (
        <span className="pill">
          <Icon name="lock" size={12} />
          Always allowed
        </span>
      ) : DEVELOPMENT_HOST.test(host) ? (
        <span className="pill mu">Development</span>
      ) : (
        <span />
      )}
      {fixed ? (
        <span className="gap" />
      ) : (
        <button type="button" className="ib dg" aria-label={`Remove ${origin}`} data-tip onClick={() => onRemove(origin)}>
          <Icon name="trash" size={18} />
        </button>
      )}
    </div>
  );
}
