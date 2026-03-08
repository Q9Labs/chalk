import { useTheme } from "../context/theme";

export function EdgeNetworkIllustration() {
  const { theme } = useTheme();
  
  return (
    <div className="relative w-full h-full min-h-[400px] flex items-center justify-center pointer-events-none select-none">
      <svg
        width="600"
        height="400"
        viewBox="0 0 600 400"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="overflow-visible"
      >
        {/* Core Nodes */}
        <defs>
          <radialGradient id="nodeGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(300 200) rotate(90) scale(150)">
            <stop stopColor="#1bb6a6" stopOpacity="0.2" />
            <stop offset="1" stopColor="#1bb6a6" stopOpacity="0" />
          </radialGradient>
          
          <filter id="blurFilter" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="15" />
          </filter>
        </defs>

        {/* Atmosphere */}
        <circle cx="300" cy="200" r="180" fill="url(#nodeGlow)" />
        
        {/* Connecting Lines */}
        <g stroke={theme === 'dark' ? 'white' : '#1bb6a6'} strokeWidth="0.5" strokeOpacity="0.1">
          <path d="M100 100 L300 200 M500 100 L300 200 M100 300 L300 200 M500 300 L300 200" />
          <circle cx="300" cy="200" r="200" strokeDasharray="4 8" />
        </g>

        {/* Animated Particles (The "Data") */}
        <g>
          {/* Top Left -> Center */}
          <circle r="3" fill="#1bb6a6">
            <animateMotion
              dur="3s"
              repeatCount="indefinite"
              path="M100 100 L300 200"
            />
            <animate attributeName="opacity" values="0;1;0" dur="3s" repeatCount="indefinite" />
          </circle>

          {/* Top Right -> Center */}
          <circle r="3" fill="#1bb6a6">
            <animateMotion
              dur="2.5s"
              begin="0.5s"
              repeatCount="indefinite"
              path="M500 100 L300 200"
            />
            <animate attributeName="opacity" values="0;1;0" dur="2.5s" repeatCount="indefinite" />
          </circle>

          {/* Bottom Left -> Center */}
          <circle r="3" fill="#1bb6a6">
            <animateMotion
              dur="4s"
              begin="1s"
              repeatCount="indefinite"
              path="M100 300 L300 200"
            />
            <animate attributeName="opacity" values="0;1;0" dur="4s" repeatCount="indefinite" />
          </circle>

          {/* Bottom Right -> Center */}
          <circle r="3" fill="#1bb6a6">
            <animateMotion
              dur="3.5s"
              begin="1.5s"
              repeatCount="indefinite"
              path="M500 300 L300 200"
            />
            <animate attributeName="opacity" values="0;1;0" dur="3.5s" repeatCount="indefinite" />
          </circle>
        </g>

        {/* Pulse Ring */}
        <circle cx="300" cy="200" r="40" stroke="#1bb6a6" strokeWidth="1" strokeOpacity="0.5">
          <animate attributeName="r" from="40" to="100" dur="2s" repeatCount="indefinite" />
          <animate attributeName="stroke-opacity" from="0.5" to="0" dur="2s" repeatCount="indefinite" />
        </circle>

        {/* Main Hub Node */}
        <g className="animate-pulse">
          <circle cx="300" cy="200" r="12" fill="#1bb6a6" />
          <circle cx="300" cy="200" r="24" stroke="#1bb6a6" strokeWidth="2" strokeOpacity="0.2" />
        </g>

        {/* External Nodes */}
        <circle cx="100" cy="100" r="6" fill={theme === 'dark' ? '#333' : '#eee'} stroke="#1bb6a6" strokeWidth="1" />
        <circle cx="500" cy="100" r="6" fill={theme === 'dark' ? '#333' : '#eee'} stroke="#1bb6a6" strokeWidth="1" />
        <circle cx="100" cy="300" r="6" fill={theme === 'dark' ? '#333' : '#eee'} stroke="#1bb6a6" strokeWidth="1" />
        <circle cx="500" cy="300" r="6" fill={theme === 'dark' ? '#333' : '#eee'} stroke="#1bb6a6" strokeWidth="1" />
      </svg>
      
      {/* Dynamic Floating Badges */}
      <div className="absolute top-[10%] right-[15%] glass-panel px-4 py-2 rounded-2xl flex items-center gap-3 animate-bounce shadow-xl scale-75 lg:scale-100" style={{ animationDuration: '4s' }}>
        <div className="w-2 h-2 rounded-full bg-green-500" />
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground italic">latency: 12ms</span>
      </div>

      <div className="absolute bottom-[15%] left-[10%] glass-panel px-4 py-2 rounded-2xl flex items-center gap-3 animate-bounce shadow-xl scale-75 lg:scale-100" style={{ animationDuration: '5s', animationDelay: '1s' }}>
        <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground italic">secure connection</span>
      </div>
    </div>
  );
}
