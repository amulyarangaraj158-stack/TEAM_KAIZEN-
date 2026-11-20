import React from 'react';

interface CircularGaugeProps {
  label: string;
  value: number;
  sublabel?: string;
  accentColor: string;
  size?: number;
}

export const CircularGauge: React.FC<CircularGaugeProps> = ({
  label,
  value,
  sublabel,
  accentColor,
  size = 96,
}) => {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const stroke = 7;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clamped / 100);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="rgba(148, 163, 184, 0.16)"
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={accentColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            style={{ transition: 'stroke-dashoffset 450ms cubic-bezier(0.16, 1, 0.3, 1)' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-xl font-bold tabular-nums text-[#F1F5F9]">{clamped}</span>
          <span className="text-[10px] text-[#94A3B8]">/ 100</span>
        </div>
      </div>
      <div className="text-center">
        <div className="text-xs font-medium text-[#F1F5F9]">{label}</div>
        {sublabel && <div className="text-[11px] font-mono" style={{ color: accentColor }}>{sublabel}</div>}
      </div>
    </div>
  );
};
