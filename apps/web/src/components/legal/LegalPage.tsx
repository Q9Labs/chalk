import { Fragment } from "react";

type LegalPageKind = "privacy" | "terms";

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
    content: "The person who runs an Episode controls recording and transcription. Chalk shows participants when an Episode is being recorded. If you record, you are responsible for having the agreement of your participants under the laws that apply to you.",
  },
  {
    heading: "Retention and deletion",
    content:
      "We keep your data while your account or tenant is active. Chat attachments and temporary transcription files expire automatically. To delete your account or specific content, contact us at the address below and we will delete or anonymize the data within 30 days. Copies can persist in encrypted backups for a limited period after deletion before they are overwritten.",
  },
  {
    heading: "Your rights",
    content:
      "If you are in the EEA, the UK, or a similar jurisdiction, you have the right to access, correct, export, and delete your personal data, to object to or restrict certain processing, and to complain to a supervisory authority (in Norway, Datatilsynet). Write to us at the address below and we will respond within the legal deadline.",
  },
  {
    heading: "International transfers",
    content: "Our providers operate globally, so your data can be processed outside your country. Where data leaves the EEA we rely on the European Commission's Standard Contractual Clauses or an adequacy decision.",
  },
  {
    heading: "Children",
    content: "Chalk is not directed at children under 16, and we do not knowingly collect their data.",
  },
  {
    heading: "Changes",
    content: "If we change this policy in a way that matters, we will announce it in the product before the change takes effect. The effective date above always reflects the current version.",
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
          <img src="/brand/chalk/chalk-logo.svg" alt="Chalk" />
        </a>
        <nav className="legal-nav" aria-label="Legal navigation">
          <a href="/privacy" className={kind === "privacy" ? "is-active" : ""}>
            Privacy
          </a>
          <a href="/terms" className={kind === "terms" ? "is-active" : ""}>
            Terms
          </a>
        </nav>
      </header>

      <main className="legal-main">
        <article className="legal-document">{kind === "privacy" ? <PrivacyPolicy /> : <TermsOfService />}</article>
      </main>
    </div>
  );
}

function PrivacyPolicy() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="legal-effective-date">Effective 7 August 2026</p>
      <p>Chalk is a real-time collaboration platform operated by Q9 Labs ("we", "us"). This policy explains what personal data Chalk collects, why, and what your rights are. It covers the Chalk web app at chalkmeet.com, the Chalk mobile app, and the APIs behind them.</p>

      <h2>What we collect</h2>
      <p>
        <strong>Account data.</strong> When you create an account we store your name, email address, and either a hash of your password or, if you sign in with Google, the identity Google returns to us (your Google account ID, verified email, and name). We never see or store your Google password. We
        also store your tenant memberships and roles.
      </p>
      <p>
        <strong>Sign-in and security data.</strong> When you sign in we record your IP address, browser user agent, and device name against that sign-in, and we keep the same details for API keys. We use this to secure your account, to let you review and revoke active sign-ins, and to rate-limit
        abusive traffic.
      </p>
      <p>
        <strong>Spaces, Episodes, and participation.</strong> Chalk stores the Spaces you create (names, settings, admission rules), the Episodes that run in them (timing and configuration), and participant records for each Episode: display name, role, capabilities, and join and leave times.
      </p>
      <p>
        <strong>Chat and files.</strong> Messages you send in an Episode are stored with your display name and timestamps. Files you attach are stored as private objects with their filename, type, and size, and expire on a schedule.
      </p>
      <p>
        <strong>Audio and video.</strong> Your microphone, camera, and screen-share streams are processed in real time to deliver them to other participants. We do not store media streams unless recording is turned on for the Episode, and the product shows when that is the case.
      </p>
      <p>
        <strong>Recordings and transcripts.</strong> Where recording or transcription is enabled, we store the recording files, transcript text, and processing metadata as private objects. Temporary audio chunks used for transcription are deleted automatically within 24 hours.
      </p>
      <p>
        <strong>Integrations and webhooks.</strong> If your tenant connects an external integration or configures webhooks, we store the connection metadata and deliver event payloads to the endpoints your tenant chose. Webhook target URLs, signing secrets, and payloads are encrypted at rest.
      </p>
      <p>
        <strong>Operational data.</strong> We keep audit logs of administrative actions, structured request logs, and bounded diagnostic events (route, outcome, duration, trace IDs). We use these to run and secure the service, and we do not use them for advertising.
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
              <code>__Host-chalk_account</code>
            </td>
            <td>Keeps you signed in (HttpOnly, Secure)</td>
            <td>Until you close your browser</td>
          </tr>
          <tr>
            <td>
              <code>__Host-chalk_csrf</code>
            </td>
            <td>Protects against cross-site request forgery</td>
            <td>Until you close your browser</td>
          </tr>
          <tr>
            <td>
              <code>__Host-chalk_oauth_return</code>
            </td>
            <td>Returns you to the right page after Google sign-in</td>
            <td>10 minutes</td>
          </tr>
          <tr>
            <td>
              <code>__Secure-chalk_participant_credential</code>
            </td>
            <td>Lets you return to a Space you were admitted to</td>
            <td>1 hour</td>
          </tr>
        </tbody>
      </table>

      <h2>Who processes your data</h2>
      <p>We use a small set of infrastructure providers, each bound by a data processing agreement:</p>
      <ul>
        <li>
          <strong>Cloudflare</strong> hosts the web app, routes API traffic, carries real-time audio and video (Realtime SFU), and stores files, recordings, and transcripts (R2). Cloudflare Workers AI performs speech-to-text when transcription is enabled.
        </li>
        <li>
          <strong>Google</strong> processes your sign-in only if you choose "Continue with Google".
        </li>
        <li>
          <strong>Amazon Web Services</strong> runs the transcription pipeline (job scheduling and secret storage) when transcription is enabled.
        </li>
        <li>
          <strong>DeepInfra</strong> may perform speech-to-text as an alternative provider when transcription is enabled.
        </li>
        <li>
          <strong>DigitalOcean</strong> runs recording workers when recording is enabled.
        </li>
        <li>
          <strong>Composio</strong> processes integration connections if your tenant enables integrations.
        </li>
      </ul>
      <p>We do not sell personal data, and we do not share it with anyone else except when the law requires it.</p>

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
