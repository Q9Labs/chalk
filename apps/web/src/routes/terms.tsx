import { createFileRoute, Link } from "@tanstack/react-router";
import { ChalkLogo } from "../components/ChalkLogo";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";

export const Route = createFileRoute("/terms")({
  component: TermsOfService,
});

function TermsOfService() {
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
          <h1 className="text-4xl font-black tracking-tight mb-2">Terms of Service</h1>
          <p className="text-muted-foreground">Last updated: {new Date().toLocaleDateString()}</p>
        </div>

        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6">
          <p>
            These Terms of Service ("Terms") govern your access to and use of Chalk ("the Service"), operated by Q9 Labs ("we," "us," or "our"). 
            Please read these Terms carefully before using the Service.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">1. Acceptance of Terms</h2>
          <p>
            By accessing or using the Service, you agree to be bound by these Terms and our Privacy Policy. If you do not agree to these Terms, do not use the Service.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">2. Description of Service</h2>
          <p>
            Chalk provides an ultra low-latency video conferencing platform, including features such as real-time audio/video communication, whiteboarding, screen sharing, and AI-driven meeting summaries.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">3. User Conduct</h2>
          <p>You agree not to use the Service to:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li>Violate any local, state, national, or international law or regulation.</li>
            <li>Transmit any material that is abusive, harassing, tortious, defamatory, vulgar, pornographic, obscene, libelous, or otherwise objectionable.</li>
            <li>Interfere with or disrupt the Service or servers or networks connected to the Service.</li>
            <li>Attempt to gain unauthorized access to any portion of the Service or any other accounts, computer systems, or networks.</li>
          </ul>

          <h2 className="text-2xl font-bold mt-8 mb-4">4. Account Registration via Google OAuth</h2>
          <p>
            To use certain features of the Service, you may be required to register using your Google account. You are responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">5. Intellectual Property</h2>
          <p>
            The Service and its original content, features, and functionality are and will remain the exclusive property of Q9 Labs and its licensors. The Service is protected by copyright, trademark, and other laws.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">6. Limitation of Liability</h2>
          <p>
            In no event shall Q9 Labs, nor its directors, employees, partners, agents, suppliers, or affiliates, be liable for any indirect, incidental, special, consequential or punitive damages, including without limitation, loss of profits, data, use, goodwill, or other intangible losses, resulting from your access to or use of or inability to access or use the Service.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">7. Contact Information</h2>
          <p>
            For any questions about these Terms, please contact us at support@chalk.com.
          </p>
        </div>
      </main>
    </div>
  );
}
