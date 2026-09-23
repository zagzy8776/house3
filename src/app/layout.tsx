import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'House3 — shortlet & hostel booking across Nigeria',
  description:
    'Book shortlets, serviced flats and hostel beds in Lagos, Abuja, Ibadan, Owerri and Uyo. Every booking shows the operator rate, our service fee and VAT.'
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#128a4e'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-NG">
      <body>{children}</body>
    </html>
  );
}

