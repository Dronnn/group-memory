import type { ReactNode } from 'react';

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    book: (
      <>
        <path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4z" />
        <path d="M13 7a3 3 0 0 1 3-3h5v14h-4a4 4 0 0 0-4 3" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    back: <path d="m14 5-7 7 7 7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    text: (
      <>
        <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5" />
      </>
    ),
    link: <path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" />,
    photo: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8" cy="8" r="1" />
        <path d="m3 17 6-6 4 4 3-3 5 5" />
      </>
    ),
    document: <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5" />,
    pin: <path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4zM12 15v7" />,
    trash: <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    edit: <path d="m4 16 12-12 4 4L8 20H4zM13 7l4 4" />,
    history: (
      <>
        <path d="M3 4v5h5" />
        <path d="M4 8a9 9 0 1 1-1 7M12 7v5l4 2" />
      </>
    ),
    arrow: <path d="M6 18 18 6M7 6h11v11" />,
    copy: (
      <>
        <rect x="8" y="8" width="12" height="13" rx="2" />
        <path d="M16 8V3H3v13h5" />
      </>
    ),
    filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.text}
    </svg>
  );
}
