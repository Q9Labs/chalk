import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sdk-preview")({ component: SdkPreviewPage });

function SdkPreviewPage() {
  return (
    <main className="mx-auto grid min-h-dvh max-w-4xl content-center gap-8 bg-[#f7f6f2] px-6 py-16 text-[#0c0e12]">
      <header className="max-w-2xl">
        <p className="text-sm font-semibold text-[#315f72]">Chalk React</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-[-0.03em]">A complete Space experience from one component.</h1>
        <p className="mt-4 text-base leading-7 text-[#555b65]">
          The local Space route uses the public <code>&lt;Chalk /&gt;</code> component, an opaque <code>AccessGrant</code>, and capability-driven controls.
        </p>
      </header>

      <pre className="overflow-x-auto rounded-lg border border-[#deddd7] bg-white p-5 text-sm leading-6 shadow-[0_22px_54px_rgba(12,14,18,0.08)]">
        <code>{`<Chalk
  space="design-review"
  getAccess={getAccess}
  entrance={false}
/>`}</code>
      </pre>

      <a href="/space" className="inline-flex w-fit rounded-md bg-[#315f72] px-4 py-3 text-sm font-semibold text-white">
        Open a local Space
      </a>
    </main>
  );
}
