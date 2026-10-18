import { GitHubMark } from "../site/GitHubMark";
import { Icon } from "../site/Icon";
import { Facts, type Fact } from "./Facts";
import { GITHUB_URL } from "../site/links";

const FACTS: readonly Fact[] = [
  { icon: "server", title: "Your machines", line: "The API, the sync service and Postgres run where you deploy them, with the same deployment we run ourselves." },
  { icon: "file", title: "Standard Postgres", line: "No vendor-only database features. Redis only makes things faster and never holds the truth." },
  { icon: "key", title: "Your keys", line: "Access is created on your server and passed through the browser untouched." },
];

export function OpenSourceSection() {
  return (
    <section className="band" id="open-source" aria-labelledby="oss-title">
      <div className="ctn split">
        <div>
          <h2 className="h2" id="oss-title">
            Open source. Run it where you like.
          </h2>
          <p className="sub">Chalk is MIT licensed. Use chalkmeet.com, or run the API, the sync service and Postgres on your own machines.</p>
          <div className="ghrow">
            <GitHubMark size={28} />
            <div>
              <b>Q9Labs/chalk</b>
              <span className="mono mu">
                git clone <span>{GITHUB_URL}</span>
              </span>
            </div>
            <a className="btn" href={GITHUB_URL}>
              View on GitHub
              <Icon name="ext" />
            </a>
          </div>
        </div>
        <div>
          <Facts facts={FACTS} flush />
          <p className="fine">Cloudflare carries the media today. Running the media server on your own hardware needs an adapter that isn’t finished yet.</p>
          <p className="fine">Built with TypeScript, React and React Native, Go and Postgres.</p>
        </div>
      </div>
    </section>
  );
}
