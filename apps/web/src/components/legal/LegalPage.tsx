import { Fragment } from "react";
import { PreviousPrivacyPolicy } from "./PreviousPrivacyPolicy";
import { PRIVACY_EFFECTIVE_DATE_LABEL } from "../../lib/privacy-policy";
import { Logo } from "@q9labsai/chalk-react";

type LegalPageKind = "privacy" | "privacy-previous" | "terms";

type LegalSection = {
  heading: string;
  content: string;
};

const PRIVACY_SECTIONS: readonly LegalSection[] = [
  {
    heading: "Legal bases",
    content:
      "We process account, sign-in, and content data to perform our contract with you. We process security and operational data in our legitimate interest of keeping the service safe and reliable. Where we rely on consent (for example, a recorded Episode), you can withdraw it going forward at any time.",
  },
  {
    heading: "Recording notice",
    content: "Recording and transcription depend on the Space settings and can start automatically or on request. Chalk shows participants when an Episode is being recorded. If you record, you are responsible for having the agreement of your participants under the laws that apply to you.",
  },
  {
    heading: "Retention and deletion",
    content:
      "Account records remain stored until deleted. Space, Episode, and participant records (including participant ID, display name, role, and join and leave times) are kept while the tenant that owns the Space exists and are deleted from active systems when that tenant is purged. This includes web and mobile guests, even after they leave an Episode; the seven-day collaboration cleanup does not delete these records. Chat messages, read receipts, whiteboard scenes and changes, and their attached files are scheduled for cleanup seven days after an Episode ends. Recordings and transcripts follow the retention policy set for the Episode by its tenant. Webhook event bodies, deliveries, and attempt logs are scheduled for cleanup after 30 days. Endpoint settings and revision history remain while the endpoint is active; after deletion, cleanup is scheduled after 30 days once delivery references are removed, or when the tenant is purged. Log retention depends on the service and its configured provider settings. To request deletion of your web account or content, or your mobile guest data, email privacy@chalkmeet.com with enough detail to identify it (for example, the Space link, display name, and approximate date). We will delete or anonymize the data in active systems within 30 days. Backup copies may remain longer; tenant-deletion archives are retained for at least 14 days. Problem reports remain in our Discord channel until we delete them; Chalk does not automatically expire problem reports. You can request deletion at privacy@chalkmeet.com.",
  },
  {
    heading: "Your rights",
    content:
      "If you are in the EEA, the UK, or a similar jurisdiction, you have the right to access, correct, export, and delete your personal data, to object to or restrict certain processing, and to complain to a supervisory authority (in Norway, Datatilsynet). Write to us at the address below and we will respond within the legal deadline.",
  },
  {
    heading: "International transfers",
    content:
      "Our providers operate globally, so your data can be processed outside your country. For transfers outside the EEA, Cloudflare and DigitalOcean rely on the EU-US Data Privacy Framework adequacy decision for covered transfers to their certified US entities, with EU Standard Contractual Clauses in their data processing addenda as a fallback. Amazon Web Services, PlanetScale, and Axiom use the EU Standard Contractual Clauses in their data processing addenda for transfers to countries without an EU adequacy decision. Discord relies on the EU-US Data Privacy Framework adequacy decision for covered transfers to its certified US entities and EU Standard Contractual Clauses for other applicable transfers. Google relies on the EU-US Data Privacy Framework adequacy decision for covered transfers to its certified US entities and EU Standard Contractual Clauses for other applicable transfers. Apple describes EU Standard Contractual Clauses for international transfers of EEA personal data in its Privacy Policy. jsDelivr is operated by Volentio JSD Limited in the UK and uses global CDN providers; jsDelivr and esm.sh can process asset-request data internationally under their own terms. External content hosts and sign-in providers also apply their own privacy terms to their services. For DeepInfra, we rely on Standard Contractual Clauses or another lawful transfer mechanism. A copy of the relevant safeguards is available on request at privacy@chalkmeet.com.",
  },
  {
    heading: "Children",
    content: "Chalk is not directed at children under 16, and we do not knowingly collect their data.",
  },
  {
    heading: "Changes",
    content: "If we change this policy in a way that matters, we will announce it in the product before the change takes effect. The effective date above identifies when this version takes effect. Earlier versions remain available at /privacy/previous.",
  },
  {
    heading: "Contact",
    content: "Q9 Labs — privacy@chalkmeet.com",
  },
];

const TERMS_SECTIONS: readonly LegalSection[] = [
  {
    heading: "Acceptable use",
    content:
      "Do not use Chalk to break the law, to infringe others' rights, to harass people, to distribute malware, or to probe or overload the platform. Do not resell access to the service without our written agreement. We can suspend accounts or tenants that put the service or its users at risk, and we will tell you why unless the law prevents it.",
  },
  {
    heading: "APIs and SDKs",
    content: "Tenant API keys and the Chalk SDKs may only be used against your own tenant's resources and within any published rate limits. Keep API keys secret; anyone holding a key can act as your tenant.",
  },
  {
    heading: "Termination",
    content: "You can stop using Chalk and ask us to delete your account at any time. We can terminate accounts that break these terms, and we can wind down the early-access service itself with reasonable notice, in which case we will give you a way to export your content.",
  },
  {
    heading: "Warranty and liability",
    content:
      "Chalk is provided as is, without warranties of any kind, to the extent the law allows. To the same extent, our total liability for any claim connected to the service is limited to the amount you paid us for it in the twelve months before the claim, and we are not liable for indirect damages such as lost profits or lost data. Nothing in these terms limits liability that cannot be limited by law.",
  },
  {
    heading: "Changes and governing law",
    content:
      "We can update these terms; if a change matters, we will announce it in the product before it takes effect, and your continued use accepts it. These terms are governed by the laws of Norway, and disputes belong to the Norwegian courts, without limiting mandatory consumer rights in your country.",
  },
  {
    heading: "Contact",
    content: "Q9 Labs — support@chalkmeet.com",
  },
];

function LegalSections({ sections }: { sections: readonly LegalSection[] }) {
  return sections.map(({ heading, content }) => (
    <Fragment key={heading}>
      <h2>{heading}</h2>
      <p>{content}</p>
    </Fragment>
  ));
}

export function LegalPage({ kind }: { kind: LegalPageKind }) {
  return (
    <div className="legal-page">
      <header className="legal-header">
        <a href="/" className="legal-brand" aria-label="Chalk home">
          <Logo accessibilityLabel={null} color="currentColor" height={30} variant="wordmark" />
        </a>
        <nav className="legal-nav" aria-label="Legal navigation">
          <a href="/privacy" className={kind !== "terms" ? "is-active" : ""}>
            Privacy
          </a>
          <a href="/terms" className={kind === "terms" ? "is-active" : ""}>
            Terms
          </a>
        </nav>
      </header>

      <main className="legal-main">
        <article className="legal-document">{kind === "privacy" ? <PrivacyPolicy /> : kind === "privacy-previous" ? <PreviousPrivacyPolicy /> : <TermsOfService />}</article>
      </main>
    </div>
  );
}

function PrivacyPolicy() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="legal-effective-date">Effective {PRIVACY_EFFECTIVE_DATE_LABEL}</p>
      <section id="whats-changing" aria-labelledby="privacy-changes-heading">
        <h2 id="privacy-changes-heading">What's changing</h2>
        <p>We are clarifying mobile guest data, sign-in cookies, participation records, recording and transcription, diagnostic logs, problem reports, and our providers and international transfer safeguards.</p>
        <p>
          The data-handling disclosures below describe current practice and apply when this page is published. The update date above does not delay these factual corrections. The <a href="/privacy/previous">Archived Privacy Policy</a> is available only as a historical record.
        </p>
      </section>
      <p>Chalk is a real-time collaboration platform operated by Q9 Labs ("we", "us"). This policy explains what personal data Chalk collects, why, and what your rights are. It covers the Chalk web app at chalkmeet.com, the Chalk mobile app, and the APIs behind them.</p>

      <h2>What we collect</h2>
      <p>
        <strong>Account data.</strong> The web dashboard offers Google and Apple sign-in through Chalk's own server. We receive your provider user ID, name, email address, and, from Google when available, profile picture URL. We keep these details in an encrypted sign-in cookie for up to 30 days and
        store a tenant record tied to your provider user ID and display name. Older account records, including password hashes, tenant memberships, and roles, remain stored. The mobile app does not offer accounts or sign-in; you join as a guest with a display name.
      </p>
      <p>
        <strong>Sign-in and security data.</strong> We use guest arrival credentials, participant IDs, and web session IDs to keep access working. We process IP addresses to rate-limit abusive traffic. For tenant API keys, we retain the most recent use's IP address and timestamp for security and
        audit purposes. Older sign-in records can include IP addresses, browser user agents, and device names.
      </p>
      <p>
        <strong>Spaces, Episodes, and participation.</strong> Chalk stores the Spaces you create (names, settings, admission rules), the Episodes that run in them (timing and configuration), and participant records for each Episode: participant ID, display name, role, capabilities, and join and
        leave times. We also process in-app actions such as reactions and read receipts to keep participants in sync.
      </p>
      <p>
        <strong>Chat and files.</strong> Messages you send in an Episode are stored with your display name and timestamps. Photos and documents you attach are stored as private objects with their filename, type, and size. Chat attachments are scheduled for deletion seven days after the Episode ends.
      </p>
      <p>
        <strong>Audio and video.</strong> Your microphone, camera, and screen-share streams are processed in real time to deliver them to other participants. Media travels over encrypted connections. We do not store media streams unless recording is turned on for the Episode, and the product shows
        when that is the case.
      </p>
      <p>
        <strong>Recordings and transcripts.</strong> Where recording or transcription is enabled, we store the recording files, transcript text, and processing metadata as private objects. Audio retained as a source for transcription follows the Episode's configured source window, which can be up to
        30 days. Temporary transcription chunks and orphan files have a 24-hour expiration rule.
      </p>
      <p>
        <strong>Whiteboards.</strong> We store whiteboard scenes and changes, including text, drawings, and images, so participants can collaborate. Whiteboard image files are scheduled for deletion seven days after the Episode ends.
      </p>
      <p>
        <strong>Integrations and webhooks.</strong> If your tenant connects an external integration or configures webhooks, we store the connection metadata and deliver event payloads to the endpoints your tenant chose. Webhook target URLs, signing secrets, and payloads are encrypted at rest.
      </p>
      <p>
        <strong>Operational data.</strong> We keep audit logs of administrative actions, structured request logs, and bounded diagnostic events (request path, route, outcome, duration, journey and trace IDs). These diagnostics can be linked to participation records through identifiers in request
        paths and trace context. We use these to run and secure the service, and we do not use them for advertising.
      </p>

      <h2>Cookies</h2>
      <p>Chalk uses only functional cookies. We do not use advertising or cross-site tracking cookies.</p>
      <table>
        <thead>
          <tr>
            <th scope="col">Cookie</th>
            <th scope="col">Purpose</th>
            <th scope="col">Lifetime</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>chalk_theme</code>
            </td>
            <td>Remembers your light or dark theme preference (Client-readable)</td>
            <td>1 year</td>
          </tr>
          <tr>
            <td>
              <code>__Host-chalk_session</code>, <code>__Host-chalk_binding</code>
            </td>
            <td>Keeps your dashboard sign-in and binds requests to your session (HttpOnly, Secure)</td>
            <td>Up to 30 days, or until sign-out</td>
          </tr>
          <tr>
            <td>
              <code>__Host-chalk_login_google</code>, <code>__Host-chalk_login_apple</code>
            </td>
            <td>Protects the sign-in exchange (HttpOnly, Secure)</td>
            <td>10 minutes, cleared after the callback</td>
          </tr>
          <tr>
            <td>
              <code>{"__Host-chalk_seat_{spaceId}"}</code>
            </td>
            <td>Keeps your dashboard Space access (HttpOnly, Secure)</td>
            <td>24 hours; access also requires your signed-in session</td>
          </tr>
          <tr>
            <td>
              <code>{"__Host-chalk_space_guest_{arrival_handle}"}</code>
            </td>
            <td>Keeps your public Space arrival available in this browser (HttpOnly, Secure)</td>
            <td>Until you leave or close your browser</td>
          </tr>
        </tbody>
      </table>

      <h2>Who processes your data</h2>
      <p>We use these service providers and third-party services to run Chalk:</p>
      <ul>
        <li>
          <strong>Cloudflare</strong> hosts the web app, routes API and asset traffic (including assets.chalkmeet.com), receives connection metadata such as IP addresses and user agents, carries real-time audio and video and screen sharing (Realtime SFU and STUN), and stores uploaded files,
          whiteboards, recordings, and transcripts (R2). Cloudflare Workers AI can perform speech-to-text when enabled in the transcription configuration.
        </li>
        <li>
          <strong>Amazon Web Services</strong> hosts our API and real-time application services, processes the account, participation, and collaboration data handled by those services, runs the transcription pipeline (audio processing, job scheduling, secret storage, and logs), and provides
          recording encryption key management.
        </li>
        <li>
          <strong>PlanetScale</strong> stores account and collaboration records in PostgreSQL, including account email addresses, display names, membership and participation records, chat, and whiteboard metadata.
        </li>
        <li>
          <strong>DeepInfra</strong> receives audio chunks and returns transcript text to perform speech-to-text when enabled in the transcription configuration.
        </li>
        <li>
          <strong>DigitalOcean</strong> runs recording workers that process call audio, video, screen sharing, and recording metadata when recording is enabled.
        </li>
        <li>
          <strong>Axiom</strong> receives API request logs and Sync diagnostic traces, including request paths, outcomes, timing, and journey and trace identifiers, to help us run and secure the service.
        </li>
        <li>
          <strong>Discord</strong> receives operational alerts that may include a tenant's display name. It also receives problem reports you submit through Chalk. A report includes the description you write, your display name and role, and the call name and ID. Diagnostics are included only if you
          opt in: connection status, last error code, browser or user agent, and app version. We do not add your account email address or credentials to reports. Before delivery, we check each field and the description/diagnostics pair for known Chalk credentials and known secret formats,
          normalizing full-width characters, HTML entities and inserted separators, including zero-width characters. We block every nonempty configured credential when pasted exactly, regardless of length; separator-tolerant matching applies only to credentials with at least 16 normalized
          characters. We refuse matching reports so you can edit your text. This catches accidental pastes; deliberate evasion by a credential's own holder, such as reconstructing it across unrelated call-name and description fields, is not covered. Other text you provide is sent as written,
          including any personal information or unrecognized secrets you choose to include. URLs beginning with http://, https:// or www. are sent as non-clickable text with query strings and fragments removed. Stack traces and commit IDs are kept.
        </li>
        <li>
          <strong>Google sign-in</strong> lets you authenticate your dashboard account. If you choose it, your browser contacts accounts.google.com and our server exchanges an authorization code with oauth2.googleapis.com and verifies Google's keys from www.googleapis.com. Google receives the
          sign-in request, Chalk's application identifier and callback URL, security state and nonce, and your browser's IP address and user agent. Google returns the account identity you authorize, including name, email address, and an optional profile picture. Google's own{" "}
          <a href="https://policies.google.com/privacy">Privacy Policy</a> governs its sign-in service.
        </li>
        <li>
          <strong>Apple sign-in</strong> lets you authenticate your dashboard account. If you choose it, your browser and our server contact appleid.apple.com for sign-in, an authorization code exchange, and key verification. Apple receives the sign-in request, Chalk's application identifier and
          callback URL, security state and nonce, and your browser's IP address and user agent. Apple returns the account identity you authorize, including name and email address, which can be an Apple relay address. Apple's own <a href="https://www.apple.com/legal/privacy/">Privacy Policy</a>{" "}
          governs its sign-in service.
        </li>
        <li>
          <strong>jsDelivr</strong> (Volentio JSD Limited) supplies Excalidraw styles and MathJax scripts and font data through cdn.jsdelivr.net for web calls and whiteboards. Your browser contacts it directly, including when the call UI preloads whiteboard styles. It and its CDN providers
          (Cloudflare, Fastly, and Gcore) receive your IP address, user agent, requested asset URL, request time, and any referrer your browser sends. These requests load library assets; Chalk does not send your call audio, chat, or whiteboard text as part of the asset request. See jsDelivr's{" "}
          <a href="https://www.jsdelivr.com/terms/privacy-policy">Privacy Policy</a> and <a href="https://github.com/jsdelivr/jsdelivr/blob/master/Sub-Processors.md">CDN provider list</a>.
        </li>
        <li>
          <strong>esm.sh</strong> supplies whiteboard fonts through Excalidraw's external asset loader or fallback in the web app. The CDN receives your IP address, user agent, request URL, and any referrer your browser sends to deliver those font files. The mobile app bundles its whiteboard fonts
          and scripts locally and blocks external whiteboard network requests.
        </li>
        <li>
          <strong>External whiteboard content.</strong> If you add or open an external embed or link in a web whiteboard, its host can receive your IP address, user agent, requested URL, and any referrer your browser sends. Excalidraw supports hosts including YouTube (Google), Vimeo, Figma, GitHub
          Gist, X/Twitter, Reddit, Giphy, SimplePDF, StackBlitz, Val Town, and Excalidraw's link service. Those hosts use this data to serve the content you selected under their own privacy terms. This is separate from Chalk's call-media processing; the mobile whiteboard blocks external embeds and
          network requests.
        </li>
        <li>
          <strong>Google Fonts</strong> supplies the web app's fonts through fonts.googleapis.com and fonts.gstatic.com. Your browser requests these files directly from Google, which receives your IP address and user agent. Google handles this request data under its{" "}
          <a href="https://policies.google.com/privacy">Privacy Policy</a>.
        </li>
      </ul>
      <p>We do not sell personal data or share it for advertising or tracking. Apart from the providers and third-party services listed above, content you send to other participants, and integrations your tenant chooses, we disclose data only when the law requires it.</p>

      <LegalSections sections={PRIVACY_SECTIONS} />
    </>
  );
}

function TermsOfService() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p className="legal-effective-date">Effective 7 August 2026</p>
      <p>These terms are an agreement between you and Q9 Labs ("we", "us") for the use of Chalk: the web app at chalkmeet.com, the Chalk mobile app, the Chalk SDKs, and the APIs behind them. By creating an account or joining a Space, you accept them.</p>

      <h2>The service</h2>
      <p>Chalk lets you create Spaces, run real-time Episodes in them with audio, video, screen sharing, and chat, and, where enabled, record and transcribe them. We run the platform; what happens inside your Spaces is up to you and your participants.</p>

      <h2>Early access</h2>
      <p>Chalk is in early access. Features can change or disappear, interruptions can happen, and despite our backups data can be lost. We work to keep the service stable and your data safe, but during early access you should not treat Chalk as your only copy of anything important.</p>

      <h2>Your account</h2>
      <p>You must give accurate information, keep your credentials to yourself, and be at least 16 years old. You are responsible for what happens under your account and under API keys your tenant creates. Tell us right away if you believe your account has been compromised.</p>

      <h2>Your content</h2>
      <p>Content you bring to Chalk (messages, files, recordings, transcripts, whiteboards) stays yours. You give us the license we need to store, process, and transmit it in order to run the service, and nothing more. We do not use your content to train models or for advertising.</p>
      <p>
        You are responsible for your content and for your participants' experience in your Spaces. If you record or transcribe an Episode, you must have the agreement of the people in it, as the laws that apply to you require. Our <a href="/privacy">Privacy Policy</a> explains how we handle personal
        data.
      </p>

      <LegalSections sections={TERMS_SECTIONS} />
    </>
  );
}
