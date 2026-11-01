import type { ReactNode } from "react";

type IconProps = { size?: number; className?: string };

function Svg({
  size = 16,
  className,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function IconSidebar({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </Svg>
  );
}

export function IconSearch({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}

export function IconChat({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 1 1 18 0Z" />
      <path d="M12 8v4M12 12h.01" />
    </Svg>
  );
}

export function IconBot({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 5v3M9 13h.01M15 13h.01M9 17h6" />
    </Svg>
  );
}

export function IconLayout({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="4" width="7" height="7" rx="1.5" />
      <rect x="14" y="4" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="6" rx="1.5" />
      <rect x="14" y="14" width="7" height="6" rx="1.5" />
    </Svg>
  );
}

export function IconPlus({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconFolder({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 8a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </Svg>
  );
}

export function IconFolderOpen({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 9.5V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1" />
      <path d="M3 10h16.5a1.5 1.5 0 0 1 1.4 2l-1.6 6A2 2 0 0 1 17.4 20H5a2 2 0 0 1-2-2Z" />
    </Svg>
  );
}

export function IconFile({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M14 3v5h5" />
    </Svg>
  );
}

export function IconFileCode({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M14 3v5h5M9.5 13l-2 2 2 2M14.5 13l2 2-2 2" />
    </Svg>
  );
}

export function IconSettings({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </Svg>
  );
}

export function IconBack({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M15 6 9 12l6 6" />
    </Svg>
  );
}

export function IconSun({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Svg>
  );
}

export function IconMoon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M20 14.5A7.5 7.5 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5Z" />
    </Svg>
  );
}

export function IconBell({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 7H3s3 0 3-7" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </Svg>
  );
}

export function IconDatabase({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </Svg>
  );
}

export function IconInfo({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 10v6M12 7h.01" />
    </Svg>
  );
}

export function IconMinimize({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M5 12h14" />
    </Svg>
  );
}

export function IconMaximize({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </Svg>
  );
}

export function IconClose({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

export function IconToday({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Svg>
  );
}

export function IconPlanner({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 11h18" />
      <path d="M8 15h3M13 15h3M8 18h3" />
    </Svg>
  );
}

export function IconSchedule({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </Svg>
  );
}

export function IconTimed({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 6v6l4 2" />
      <circle cx="12" cy="12" r="8" />
      <path d="M12 3v2M9 3h6" />
    </Svg>
  );
}

export function IconKnowledge({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M4 5a2 2 0 0 1 2-2h5v16H6a2 2 0 0 0-2 2Z" />
      <path d="M20 5a2 2 0 0 0-2-2h-5v16h5a2 2 0 0 1 2 2Z" />
    </Svg>
  );
}

export function IconInbox({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 12h5l2 3h4l2-3h5" />
      <path d="M3 12v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
      <path d="M5 12 8 5h8l3 7" />
    </Svg>
  );
}

export function IconTasks({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M9 7h11M9 12h11M9 17h11" />
      <path d="m4 7 1.5 1.5L8 6M4 12l1.5 1.5L8 11M4 17l1.5 1.5L8 16" />
    </Svg>
  );
}

export function IconTag({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M20.6 13.05 12.7 21a1.6 1.6 0 0 1-2.25 0L3.2 13.7A2 2 0 0 1 2.7 12.3L7.7 3.8A2 2 0 0 1 9.45 3H16a2 2 0 0 1 2 2v6.55a2 2 0 0 1-.4 1.2Z" />
      <circle cx="14.5" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconRepeat({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M17 2v4h-4" />
      <path d="M20 12a8 8 0 0 0-13.5-5.7L3 10" />
      <path d="M7 22v-4h4" />
      <path d="M4 12a8 8 0 0 0 13.5 5.7L21 14" />
    </Svg>
  );
}

export function IconFlag({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M5 21V4" />
      <path d="M5 4h10l-1.5 3.5L15 11H5" />
    </Svg>
  );
}
