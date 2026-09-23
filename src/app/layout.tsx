import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'House3 — Premium stays across Nigeria',
  description:
    'Shortlets, serviced flats and penthouse suites across Lagos, Abuja, Ibadan, Owerri and Uyo — with an itemised receipt before you pay.',
  applicationName: 'House3'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Matches --background in globals.css so mobile browser chrome blends in.
  themeColor: '#0e0c0a'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-NG">
      <body>{children}</body>
    </html>
  );
}


