'use client';

/**
 * Search modal - ported from the design.
 *
 * Behaviour change: it is now a real form. The design's "Search available
 * spaces" button only closed the modal, which is a dead end. This submits to
 * /search with the same query parameters the booking flow already understands,
 * so the modal becomes a genuine entry point into the funnel.
 */

import { useState, type FormEvent } from 'react';
import { SEARCH_COVERAGE } from '@/content/marketing';

const FIELD_BOX = { background: 'var(--secondary)', border: '1px solid var(--border)' } as const;
const FIELD_LABEL = {
  color: 'var(--muted-foreground)',
  fontFamily: 'var(--font-outfit)'
} as const;

export function SearchModal({ onClose }: { onClose: () => void }) {
  const [loc, setLoc] = useState('');
  const [checkin, setCheckin] = useState('');
  const [checkout, setCheckout] = useState('');
  const [guests, setGuests] = useState('2');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (loc.trim()) params.set('area', loc.trim());
    if (checkin) params.set('checkIn', checkin);
    if (checkout) params.set('checkOut', checkout);
    params.set('guests', guests);
    window.location.href = `/search?${params.toString()}`;
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(12px)' }}
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-xl rounded-3xl p-8"
        style={{
          background: 'var(--card)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 40px 120px rgba(0,0,0,0.8)'
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-8">
          <div>
            <h2
              className="text-3xl font-light mb-1"
              style={{ fontFamily: 'var(--font-fraunces)', color: 'var(--foreground)' }}
            >
              Find a space
            </h2>
            <p className="text-sm m-0" style={FIELD_LABEL}>
              {SEARCH_COVERAGE}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="hover:opacity-60 transition-opacity"
            style={{
              color: 'var(--muted-foreground)',
              fontSize: 22,
              lineHeight: 1,
              background: 'none',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl overflow-hidden" style={FIELD_BOX}>
            <label
              htmlFor="h3-search-loc"
              className="block px-5 pt-4 pb-1 text-xs tracking-widest font-medium"
              style={FIELD_LABEL}
            >
              CITY OR NEIGHBOURHOOD
            </label>
            <input
              id="h3-search-loc"
              value={loc}
              onChange={(event) => setLoc(event.target.value)}
              placeholder="e.g. Lekki, Maitama, Bodija…"
              className="w-full px-5 pb-4 bg-transparent outline-none text-base"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-outfit)' }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {[
              { id: 'h3-search-in', label: 'CHECK-IN', val: checkin, set: setCheckin },
              { id: 'h3-search-out', label: 'CHECK-OUT', val: checkout, set: setCheckout }
            ].map((field) => (
              <div key={field.id} className="rounded-2xl overflow-hidden" style={FIELD_BOX}>
                <label
                  htmlFor={field.id}
                  className="block px-5 pt-4 pb-1 text-xs tracking-widest font-medium"
                  style={FIELD_LABEL}
                >
                  {field.label}
                </label>
                <input
                  id={field.id}
                  type="date"
                  value={field.val}
                  onChange={(event) => field.set(event.target.value)}
                  className="w-full px-5 pb-4 bg-transparent outline-none text-sm"
                  style={{ color: 'var(--foreground)', fontFamily: 'var(--font-outfit)', colorScheme: 'dark' }}
                />
              </div>
            ))}
          </div>

          <div className="rounded-2xl overflow-hidden" style={FIELD_BOX}>
            <label
              htmlFor="h3-search-guests"
              className="block px-5 pt-4 pb-1 text-xs tracking-widest font-medium"
              style={FIELD_LABEL}
            >
              GUESTS
            </label>
            <select
              id="h3-search-guests"
              value={guests}
              onChange={(event) => setGuests(event.target.value)}
              className="w-full px-5 pb-4 bg-transparent outline-none text-base appearance-none"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-outfit)' }}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n} value={n} style={{ background: '#1a1714' }}>
                  {n} guest{n !== 1 ? 's' : ''}
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            className="w-full py-4 rounded-2xl font-semibold text-base transition-all duration-200 hover:opacity-90 mt-2"
            style={{
              background: 'var(--primary)',
              color: 'var(--primary-foreground)',
              fontFamily: 'var(--font-outfit)',
              letterSpacing: '0.01em',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            Search available spaces
          </button>
        </div>
      </form>
    </div>
  );
}
