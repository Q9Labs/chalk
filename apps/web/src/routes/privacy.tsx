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
          <p className="text-muted-foreground">Last updated: {new Date().toLocaleDateString()}</p>
        </div>

        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6">
          <p>
            Welcome to Chalk ("we," "our," or "us"). We are committed to protecting your personal information and your right to privacy.
            This Privacy Policy explains how we collect, use, and share your information when you use our video conferencing application.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">1. Information We Collect</h2>
          <p>
            We collect personal information that you voluntarily provide to us when you register on the application, express an interest in obtaining information about us or our products, or when you participate in activities on the application.
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong>Personal Information:</strong> such as your name, email address, and profile picture, primarily provided through Google OAuth.</li>
            <li><strong>Meeting Data:</strong> video, audio, chat transcripts, and whiteboard data generated during your sessions.</li>
            <li><strong>Usage Data:</strong> diagnostic information, device information, and interaction logs.</li>
          </ul>

          <h2 className="text-2xl font-bold mt-8 mb-4">2. How We Use Your Information</h2>
          <p>We use the information we collect or receive to:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li>Facilitate account creation and logon process.</li>
            <li>Provide and manage the video conferencing service, including generating intelligent summaries and action items.</li>
            <li>Respond to user inquiries and offer support to users.</li>
            <li>Protect our application and ensure platform security.</li>
          </ul>

          <h2 className="text-2xl font-bold mt-8 mb-4">3. Sharing of Information</h2>
          <p>
            We only share information with your consent, to comply with laws, to provide you with services, to protect your rights, or to fulfill business obligations. We do not sell your personal information to third parties.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">4. Google API Services Usage</h2>
          <p>
            Chalk's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer" className="text-primary hover:underline">Google API Services User Data Policy</a>, including the Limited Use requirements.
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">5. Contact Us</h2>
          <p>
            If you have questions or comments about this policy, you may email us at privacy@chalk.com.
          </p>
        </div>
      </main>
    </div>
  );
}
