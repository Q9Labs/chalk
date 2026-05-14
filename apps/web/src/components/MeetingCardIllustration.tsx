export function MeetingCardIllustration({ active = false }: { active?: boolean }) {
  return (
    <div className="absolute right-0 top-0 w-48 h-full overflow-hidden pointer-events-none opacity-20 dark:opacity-10 group-hover:opacity-40 transition-opacity duration-500">
      <svg width="200" height="200" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" className="absolute top-0 right-[-50px]">
        <circle cx="100" cy="100" r="80" stroke="currentColor" strokeWidth="0.5" className={active ? "animate-pulse" : ""} />
        <circle cx="100" cy="100" r="60" stroke="currentColor" strokeWidth="0.5" strokeDasharray="4 4" />

        {/* Floating Data Nodes */}
        <g className="text-primary">
          <circle r="2" fill="currentColor">
            <animateMotion dur="10s" repeatCount="indefinite" path="M100 20 A 80 80 0 1 1 99.9 20" />
          </circle>
          <circle r="2" fill="currentColor">
            <animateMotion dur="15s" begin="-5s" repeatCount="indefinite" path="M100 40 A 60 60 0 1 0 100.1 40" />
          </circle>
        </g>

        {/* Abstract Lines */}
        <line x1="100" y1="20" x2="100" y2="180" stroke="currentColor" strokeWidth="0.2" />
        <line x1="20" y1="100" x2="180" y2="100" stroke="currentColor" strokeWidth="0.2" />
      </svg>
    </div>
  );
}
