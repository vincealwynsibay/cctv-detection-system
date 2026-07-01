import { cn } from '@/lib/utils';

interface AllClearMascotProps {
  size?: number;
  className?: string;
}

/**
 * Friendly traffic officer mascot for the dashboard's "all clear" panel.
 * Stylised flat illustration: stocky proportions, soft palette, thumbs-up
 * pose.
 */
export function AllClearMascot({ size = 140, className }: AllClearMascotProps) {
  const h = Math.round(size * 1.15);
  return (
    <svg
      width={size}
      height={h}
      viewBox="0 0 140 160"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="All clear"
      role="img"
      className={cn(className)}
    >
      <defs>
        <linearGradient id="ac-vest" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>
        <linearGradient id="ac-cap" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1e3a8a" />
          <stop offset="100%" stopColor="#1e40af" />
        </linearGradient>
        <radialGradient id="ac-cheek" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="#fda4af" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#fda4af" stopOpacity="0"   />
        </radialGradient>
      </defs>

      <style>{`
        @keyframes ac-bob   { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
        @keyframes ac-wave  { 0%,100% { transform: rotate(-6deg); } 50% { transform: rotate(6deg); } }
        @keyframes ac-blink { 0%,88%,100% { transform: scaleY(1); } 92% { transform: scaleY(0.05); } }

        .ac-body    { animation: ac-bob   3.4s ease-in-out infinite; transform-origin: 70px 110px; }
        .ac-thumb   { animation: ac-wave  2.6s ease-in-out infinite; transform-origin: 100px 92px; }
        .ac-eye     { animation: ac-blink 5s   ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
      `}</style>

      {/* Soft ground shadow */}
      <ellipse cx="70" cy="150" rx="34" ry="4" fill="#0f172a" opacity="0.10" />

      <g className="ac-body">
        {/* Body / vest */}
        <path
          d="M40 148 C40 124, 40 108, 50 100 L90 100 C100 108, 100 124, 100 148 Z"
          fill="url(#ac-vest)"
        />
        {/* Reflective vest stripes */}
        <rect x="46" y="120" width="48" height="5" rx="2" fill="#fef3c7" opacity="0.9" />
        <rect x="46" y="132" width="48" height="5" rx="2" fill="#fef3c7" opacity="0.9" />

        {/* Vest collar */}
        <path d="M58 100 L70 110 L82 100 Z" fill="#065f46" />

        {/* Neck */}
        <rect x="64" y="86" width="12" height="14" rx="3" fill="#fde7d4" />

        {/* Head */}
        <circle cx="70" cy="68" r="24" fill="#fde7d4" />

        {/* Hair shadow under cap (just a hint) */}
        <path d="M50 60 C56 56, 84 56, 90 60 L90 70 L50 70 Z" fill="#1f2937" opacity="0.18" />

        {/* Cap */}
        <path
          d="M44 56 C50 38, 90 38, 96 56 L96 60 L44 60 Z"
          fill="url(#ac-cap)"
        />
        <rect x="44" y="58" width="52" height="4" rx="2" fill="#0f172a" />
        {/* Cap badge */}
        <circle cx="70" cy="50" r="4.5" fill="#fbbf24" stroke="#92400e" strokeWidth="1" />
        <path d="M70 47.5 L70.8 49.5 L72.8 49.7 L71.3 51 L71.8 53 L70 51.9 L68.2 53 L68.7 51 L67.2 49.7 L69.2 49.5 Z" fill="#92400e" />

        {/* Cheeks */}
        <circle cx="59" cy="76" r="5" fill="url(#ac-cheek)" />
        <circle cx="81" cy="76" r="5" fill="url(#ac-cheek)" />

        {/* Eyes */}
        <ellipse className="ac-eye" cx="61" cy="70" rx="2.4" ry="3.2" fill="#0f172a" />
        <ellipse className="ac-eye" cx="79" cy="70" rx="2.4" ry="3.2" fill="#0f172a" />
        <circle cx="62" cy="69" r="0.9" fill="#fff" />
        <circle cx="80" cy="69" r="0.9" fill="#fff" />

        {/* Smile */}
        <path d="M62 79 Q70 86 78 79" stroke="#0f172a" strokeWidth="1.8" strokeLinecap="round" fill="none" />

        {/* Left arm (resting) */}
        <path
          d="M44 108 C36 116, 36 130, 44 138 L52 134 C50 126, 50 116, 52 110 Z"
          fill="url(#ac-vest)"
        />
        {/* Left hand */}
        <circle cx="42" cy="138" r="5" fill="#fde7d4" />

        {/* Right arm (thumbs-up, animated) */}
        <g className="ac-thumb">
          <path
            d="M88 108 C100 102, 108 96, 106 86 L96 86 C94 92, 88 96, 84 100 Z"
            fill="url(#ac-vest)"
          />
          {/* Thumbs-up fist */}
          <g transform="translate(104 82)">
            <circle r="6.5" fill="#fde7d4" />
            <path
              d="M-1 -2 L-1 -10 C-1 -12, 3 -12, 3 -10 L3 -2 Z"
              fill="#fde7d4"
              stroke="#c98c64"
              strokeWidth="0.6"
            />
            <path d="M-4 -1 H4" stroke="#c98c64" strokeWidth="0.6" />
          </g>
        </g>
      </g>
    </svg>
  );
}
