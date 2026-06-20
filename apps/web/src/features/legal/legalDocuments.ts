export function slugifyLegalSection(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const LEGAL_DOCUMENTS = {
  privacy: {
    slug: "privacy",
    title: "Privacy Policy",
    lastUpdated: "March 22, 2026",
    introHtml: "<p>Chalk is operated by Q9 Labs. This Privacy Policy explains how Chalk accesses, collects, uses, retains, and shares data when you create or join meetings, use chat and whiteboards, or interact with related collaboration features on our web and mobile apps.</p>",
    sections: [
      {
        title: "1. Information We Collect",
        bodyHtml: `
          <ul>
            <li><strong>Account and contact information:</strong> information you choose to provide, such as a display name, email address, or support request details.</li>
            <li><strong>Meeting content:</strong> live audio and video, chat messages, transcripts, whiteboard content, meeting identifiers, and related participant metadata generated while using Chalk.</li>
            <li><strong>Technical and diagnostic information:</strong> device, network, and service events needed to deliver calls, troubleshoot issues, prevent abuse, and improve reliability.</li>
            <li><strong>Invite and session data stored on device:</strong> the mobile app may store limited local session data such as secure join context or locally pasted Chalk invite links to help you continue a meeting flow.</li>
          </ul>
        `.trim(),
      },
      {
        title: "2. How We Use Your Information",
        bodyHtml: `
          <ul>
            <li>Provide Chalk meetings, chat, transcripts, whiteboards, recordings, and other collaboration features.</li>
            <li>Route media, establish sessions, maintain quality, reconnect users, and secure the platform.</li>
            <li>Respond to support requests, investigate incidents, and enforce our terms and abuse-prevention rules.</li>
            <li>Generate meeting outputs such as transcripts, summaries, and action items when those features are enabled.</li>
          </ul>
        `.trim(),
      },
      {
        title: "3. Permissions and Sensitive Access",
        bodyHtml:
          "<p>Chalk requests camera and microphone access so meeting participants can send audio and video. On mobile, Chalk may also inspect the clipboard to suggest a Chalk invite link that is already on your device. If Chalk introduces any collection or sharing that is outside a user's reasonable expectation, we will add the required in-app disclosure and consent flow.</p>",
      },
      {
        title: "4. Sharing of Information",
        bodyHtml:
          "<p>We do not sell personal information. We may share data with service providers and infrastructure partners that process data on our behalf to run Chalk, with participants in the same meeting as needed to provide the service, when you direct us to share it, or when required by law or needed to protect users, Chalk, or our rights.</p>",
      },
      {
        title: "5. Security",
        bodyHtml: "<p>We use administrative, technical, and organizational safeguards designed to protect personal and sensitive data in transit and at rest. No method of transmission or storage is perfectly secure, but we work to reduce risk and respond quickly to issues.</p>",
      },
      {
        title: "6. Retention and Deletion",
        bodyHtml:
          "<p>We keep data for as long as needed to provide Chalk, comply with legal obligations, resolve disputes, enforce agreements, and maintain security and operational records. Local session data stored on your device can be cleared by uninstalling the app or clearing app storage. For deletion or privacy requests, contact us using the details below so we can review the request in context.</p>",
      },
      {
        title: "7. Contact Us",
        bodyHtml: '<p>Questions, requests, or concerns about this policy may be sent to <a href="mailto:privacy@chalk.com">privacy@chalk.com</a>.</p>',
      },
    ],
  },
  terms: {
    slug: "terms",
    title: "Terms of Service",
    lastUpdated: "March 22, 2026",
    introHtml: '<p>These Terms of Service ("Terms") govern your access to and use of Chalk ("the Service"), operated by Q9 Labs ("we," "us," or "our"). Please read these Terms carefully before using the Service.</p>',
    sections: [
      {
        title: "1. Acceptance of Terms",
        bodyHtml: "<p>By accessing or using the Service, you agree to be bound by these Terms and our Privacy Policy. If you do not agree to these Terms, do not use the Service.</p>",
      },
      {
        title: "2. Description of Service",
        bodyHtml: "<p>Chalk provides an ultra low-latency video conferencing platform, including features such as real-time audio and video communication, whiteboarding, screen sharing, and AI-driven meeting summaries.</p>",
      },
      {
        title: "3. User Conduct",
        bodyHtml: `
          <p>You agree not to use the Service to:</p>
          <ul>
            <li>Violate any local, state, national, or international law or regulation.</li>
            <li>Transmit any material that is abusive, harassing, tortious, defamatory, vulgar, pornographic, obscene, libelous, or otherwise objectionable.</li>
            <li>Interfere with or disrupt the Service or servers or networks connected to the Service.</li>
            <li>Attempt to gain unauthorized access to any portion of the Service or any other accounts, computer systems, or networks.</li>
          </ul>
        `.trim(),
      },
      {
        title: "4. Intellectual Property",
        bodyHtml: "<p>The Service and its original content, features, and functionality are and will remain the exclusive property of Q9 Labs and its licensors. The Service is protected by copyright, trademark, and other laws.</p>",
      },
      {
        title: "5. Limitation of Liability",
        bodyHtml:
          "<p>In no event shall Q9 Labs, nor its directors, employees, partners, agents, suppliers, or affiliates, be liable for any indirect, incidental, special, consequential or punitive damages, including without limitation, loss of profits, data, use, goodwill, or other intangible losses, resulting from your access to or use of or inability to access or use the Service.</p>",
      },
      {
        title: "6. Contact Information",
        bodyHtml: '<p>For any questions about these Terms, please contact us at <a href="mailto:support@example.com">support@example.com</a>.</p>',
      },
    ],
  },
} as const;

export const PRIVACY_POLICY_DOCUMENT = LEGAL_DOCUMENTS.privacy;
export const TERMS_OF_SERVICE_DOCUMENT = LEGAL_DOCUMENTS.terms;

export type LegalDocument = (typeof LEGAL_DOCUMENTS)[keyof typeof LEGAL_DOCUMENTS];
