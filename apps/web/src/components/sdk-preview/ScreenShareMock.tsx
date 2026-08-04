export function ScreenShareMock() {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden border border-[#c9c8c2] bg-white shadow-[0_8px_30px_rgba(12,14,18,0.08)]">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-[#deddd7] bg-[#f4f3ef] px-4">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-[#d67b7b]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#d9b641]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#80b879]" />
        </div>
        <div className="mx-auto max-w-[460px] flex-1 truncate rounded-[6px] border border-[#deddd7] bg-white px-3 py-1 text-center font-mono text-[10px] text-[#858a92]">chalk.team/docs/product-review</div>
        <span className="text-[10px] text-[#6d727b]">Shared by Nora</span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 bg-[#fbfaf7] sm:grid-cols-[150px_minmax(0,1fr)]">
        <aside className="hidden border-r border-[#deddd7] p-4 sm:block">
          <p className="text-sm font-semibold">Workspace</p>
          <div className="mt-5 space-y-2 text-xs text-[#6d727b]">
            <p className="rounded-[6px] bg-[#eaf7fb] px-2.5 py-2 font-medium text-[#315f72]">Product review</p>
            <p className="px-2.5 py-2">Research</p>
            <p className="px-2.5 py-2">Release plan</p>
            <p className="px-2.5 py-2">Open questions</p>
          </div>
        </aside>
        <div className="min-w-0 overflow-auto px-[6%] py-6 sm:px-[8%] sm:py-8">
          <div className="mx-auto max-w-[720px]">
            <div className="flex items-center justify-between border-b border-[#deddd7] pb-5">
              <div>
                <h2 className="text-2xl font-semibold tracking-[-0.035em]">Design review</h2>
                <p className="mt-1 text-xs text-[#6d727b]">Friday, August 1 · Product & engineering</p>
              </div>
              <button type="button" className="rounded-[7px] bg-[#202329] px-3 py-2 text-xs font-semibold !text-white">
                Share
              </button>
            </div>
            <div className="mt-7 grid gap-4 sm:grid-cols-3">
              {[
                { value: "42 ms", label: "p95 join time" },
                { value: "99.99%", label: "Space availability" },
                { value: "5", label: "open decisions" },
              ].map((item) => (
                <div key={item.label} className="rounded-[8px] border border-[#deddd7] bg-white p-4">
                  <p className="font-mono text-xl font-semibold">{item.value}</p>
                  <p className="mt-1 text-xs text-[#6d727b]">{item.label}</p>
                </div>
              ))}
            </div>
            <div className="mt-7 grid gap-7 sm:grid-cols-[minmax(0,1fr)_190px]">
              <div>
                <h3 className="text-base font-semibold">Today’s decisions</h3>
                <div className="mt-3 space-y-3">
                  {["Keep Space controls in reserved space below the stage", "Ship whiteboard as a first-class collaborative surface", "Use a single calm focus border across form controls"].map((text, index) => (
                    <div key={text} className="flex items-start gap-3 rounded-[8px] border border-[#deddd7] bg-white p-3 text-xs leading-5">
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#e8f1e4] font-mono text-[10px] text-[#49645d]">{index + 1}</span>
                      {text}
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-[8px] border border-[#deddd7] bg-[#fdf7e6] p-4">
                <p className="text-sm font-semibold">Next checkpoint</p>
                <p className="mt-2 text-xs leading-5 text-[#6d727b]">Mobile concepts and browser proof before handoff.</p>
                <p className="mt-5 font-mono text-xs">4:30 PM</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
