import { Fragment } from "react";

// Archived verbatim from master at 2de92e3c178cf3c86f92b1c33146f66495816c8a.
const PRIVACY_SECTIONS = [
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

export function PreviousPrivacyPolicy() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="legal-effective-date">Effective 7 August 2026</p>
      <p>Chalk is a real-time collaboration platform operated by Q9 Labs ("we", "us"). This policy explains what personal data Chalk collects, why, and what your rights are. It covers the Chalk web app at chalkmeet.com, the Chalk mobile app, and the APIs behind them.</p>

      <h2>What we collect</h2>
      <p>
        <strong>Account data.</strong> Account creation and sign-in are currently unavailable. Existing account records, including names, email addresses, password hashes or Google identity details, tenant memberships, and roles, remain stored.
      </p>
      <p>
        <strong>Sign-in and security data.</strong> We retain previously recorded sign-in security data, including IP addresses, browser user agents, and device names. We record the same details for API keys to secure access and rate-limit abusive traffic.
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
              <code>{"__Host-chalk_space_guest_{arrival_handle}"}</code>
            </td>
            <td>Keeps your public Space arrival available in this browser (HttpOnly, Secure)</td>
            <td>Until you leave or close your browser</td>
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
          <strong>Amazon Web Services</strong> runs the transcription pipeline (job scheduling and secret storage) when transcription is enabled.
        </li>
        <li>
          <strong>DeepInfra</strong> may perform speech-to-text as an alternative provider when transcription is enabled.
        </li>
        <li>
          <strong>DigitalOcean</strong> runs recording workers when recording is enabled.
        </li>
      </ul>
      <p>We do not sell personal data, and we do not share it with anyone else except when the law requires it.</p>

      {PRIVACY_SECTIONS.map(({ heading, content }) => (
        <Fragment key={heading}>
          <h2>{heading}</h2>
          <p>{content}</p>
        </Fragment>
      ))}
    </>
  );
}
