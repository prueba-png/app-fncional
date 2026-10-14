const PATHS = {
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  edit: "M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4",
  copy: "M8 8h11v11H8zM5 16V5h11",
  download: "M12 4v11m0 0l-4-4m4 4l4-4M5 20h14",
  upload: "M12 20V9m0 0l-4 4m4-4l4 4M5 4h14",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
  save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
  send: "M4 12l16-8-6 16-3-7-7-1z",
  stop: "M7 7h10v10H7z",
  refresh: "M20 11a8 8 0 10-2.3 5.7M20 4v7h-7",
  chat: "M4 5h16v11H9l-5 4z",
  history: "M3 12a9 9 0 103-6.7M3 4v5h5M12 7v5l3 3",
  globe: "M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5a1.5 1.5 0 100-.01",
  package: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  cloud: "M7 18a5 5 0 01-.6-10A6 6 0 0118 9a4.5 4.5 0 01-.5 9z",
  monitor: "M3 5h18v11H3zM8 20h8M12 16v4",
  tablet: "M6 3h12v18H6zM11 18h2",
  phone: "M8 3h8v18H8zM11 18h2",
  terminal: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5",
  x: "M6 6l12 12M18 6L6 18",
  check: "M5 12l5 5 9-10",
  folder: "M3 6h6l2 2h10v11H3z",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  zip: "M6 3h12v18H6zM11 5h2M11 8h2M11 11h2M10 14h4v4h-4z",
  bolt: "M13 3L5 14h6l-1 7 8-11h-6z",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
  sparkles: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  shrink: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  sun: "M12 4V2M12 22v-2M4.9 4.9L3.5 3.5M20.5 20.5l-1.4-1.4M4 12H2M22 12h-2M4.9 19.1l-1.4 1.4M20.5 3.5l-1.4 1.4M12 17a5 5 0 100-10 5 5 0 000 10z",
  moon: "M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z",
  translate: "M3 5h9M7.5 3v2M4 15c3-1 6-4 7-9M11 12c-1 3-4 6-7 7M13 20l4-9 4 9M14.5 17h5",
  wand: "M4 20L15 9M17.5 3l.8 2.2L20.5 6l-2.2.8-.8 2.2-.8-2.2L14.5 6l2.2-.8zM5.5 12l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7L3.2 14.3l1.7-.6zM19 15l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5L17 17l1.5-.5z",
  mic: "M12 15a3 3 0 003-3V6a3 3 0 10-6 0v6a3 3 0 003 3zM6 11a6 6 0 0012 0M12 19v3",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
