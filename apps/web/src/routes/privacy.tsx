import { createFileRoute, Link } from "@tanstack/react-router";
import { ChalkLogo } from "../components/ChalkLogo";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPolicy,
});

function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-background text-foreground font-app">
      <header className="h-16 border-b border-border flex items-center px-6 gap-4 sticky top-0 bg-background/80 backdrop-blur-xl z-50">
        <Link to="/" className="text-muted-foreground hover:text-foreground transition-colors">
          <HugeiconsIcon icon={ArrowLeft01Icon} size={20} />
        </Link>
        <div className="w-px h-6 bg-border mx-2" />
        <Link to="/">
          <ChalkLogo className="scale-90 origin-left" />
        </Link>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12 md:py-20 space-y-8">
        <div>
          <h1 className="text-4xl font-black tracking-tight mb-2">Privacy Policy</h1>
          <p className="text-muted-foreground">Last updated: March 22, 2026</p>
        </div>

        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6">
          <p>
            Chalk is operated by Q9 Labs. This Privacy Policy explains how Chalk accesses, collects, uses, retains, and shares data when you create or join meetings, use chat and whiteboards, or interact with related collaboration features on our web and mobile apps.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">1. Information We Collect</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong>Account and contact information:</strong> information you choose to provide, such as a display name, email address, or support request details.</li>
            <li><strong>Meeting content:</strong> live audio and video, chat messages, transcripts, whiteboard content, meeting identifiers, and related participant metadata generated while using Chalk.</li>
            <li><strong>Technical and diagnostic information:</strong> device, network, and service events needed to deliver calls, troubleshoot issues, prevent abuse, and improve reliability.</li>
            <li><strong>Invite and session data stored on device:</strong> the mobile app may store limited local session data such as secure join context or locally pasted Chalk invite links to help you continue a meeting flow.</li>
          </ul>

          <h2 className="text-2xl font-bold mt-8 mb-4">2. How We Use Your Information</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>Provide Chalk meetings, chat, transcripts, whiteboards, recordings, and other collaboration features.</li>
            <li>Route media, establish sessions, maintain quality, reconnect users, and secure the platform.</li>
            <li>Respond to support requests, investigate incidents, and enforce our terms and abuse-prevention rules.</li>
            <li>Generate meeting outputs such as transcripts, summaries, and action items when those features are enabled.</li>
          </ul>

          <h2 className="text-2xl font-bold mt-8 mb-4">3. Permissions and Sensitive Access</h2>
          <p>
            Chalk requests camera and microphone access so meeting participants can send audio and video. On mobile, Chalk may also inspect the clipboard to suggest a Chalk invite link that is already on your device. If Chalk introduces any collection or sharing that is outside a user&apos;s reasonable expectation, we will add the required in-app disclosure and consent flow.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">4. Sharing of Information</h2>
          <p>
            We do not sell personal information. We may share data with service providers and infrastructure partners that process data on our behalf to run Chalk, with participants in the same meeting as needed to provide the service, when you direct us to share it, or when required by law or needed to protect users, Chalk, or our rights.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">5. Security</h2>
          <p>
            We use administrative, technical, and organizational safeguards designed to protect personal and sensitive data in transit and at rest. No method of transmission or storage is perfectly secure, but we work to reduce risk and respond quickly to issues.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">6. Retention and Deletion</h2>
          <p>
            We keep data for as long as needed to provide Chalk, comply with legal obligations, resolve disputes, enforce agreements, and maintain security and operational records. Local session data stored on your device can be cleared by uninstalling the app or clearing app storage. For deletion or privacy requests, contact us using the details below so we can review the request in context.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">7. Google API Services Usage</h2>
          <p>
            Chalk's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer" className="text-primary hover:underline">Google API Services User Data Policy</a>, including the Limited Use requirements.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">8. Contact Us</h2>
          <p>
            Questions, requests, or concerns about this policy may be sent to <a href="mailto:privacy@chalk.com" className="text-primary hover:underline">privacy@chalk.com</a>.
          </p>
        </div>
      </main>
    </div>
  );
}
