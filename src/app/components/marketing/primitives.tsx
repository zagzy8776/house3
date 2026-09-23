'use client';

/**
 * Motion primitives from the Figma Make design.
 *
 * Card3D is the pointer-tracked tilt. Two changes from the original:
 *
 *  1. Tilt is skipped on coarse pointers (phones/tablets). The original applied
 *     it unconditionally, but there is no hover on touch, so it was pure cost -
 *     and re-rendering a component on every mousemove is expensive on the cheap
 *     Android that most of our guests use.
 *  2. The transform is written straight to the node's style rather than through
 *     React state, so tracking a mouse does not trigger a re-render per frame.
 *
 * Everything else - perspective, rotation range, the 150ms ease-out - is
 * identical, so it looks the same on the machines that can afford it.
 */

import { useEffect, useRef, type ReactNode } from 'react';

export function Card3D({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // No hover on touch; skip entirely rather than burn frames on mousemove.
    if (window.matchMedia('(pointer: coarse)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const REST = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale(1)';

    function onMove(event: MouseEvent) {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      el.style.transform = `perspective(1000px) rotateX(${(-y * 7).toFixed(2)}deg) rotateY(${(x * 7).toFixed(
        2
      )}deg) scale(1.02)`;
    }

    function onLeave() {
      if (!el) return;
      el.style.transform = REST;
    }

    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        transform: 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale(1)',
        transition: 'transform 0.15s ease-out',
        transformStyle: 'preserve-3d'
      }}
    >
      {children}
    </div>
  );
}

export function FloatingOrb({
  size,
  x,
  y,
  color,
  blur,
  delay
}: {
  size: number;
  x: string;
  y: string;
  color: string;
  blur: number;
  delay: string;
}) {
  return (
    <div
      aria-hidden="true"
      className="absolute rounded-full pointer-events-none"
      style={{
        width: size,
        height: size,
        left: x,
        top: y,
        background: color,
        filter: `blur(${blur}px)`,
        opacity: 0.35,
        animation: 'float 8s ease-in-out infinite',
        animationDelay: delay
      }}
    />
  );
}

/** The float/drift keyframes the design injects inline. */
export const MOTION_KEYFRAMES = `
  @keyframes float {
    0%, 100% { transform: translateY(0px); }
    50% { transform: translateY(-20px); }
  }
  @keyframes drift {
    0%, 100% { transform: translateX(0) rotate(0deg); }
    33% { transform: translateX(10px) rotate(1deg); }
    66% { transform: translateX(-8px) rotate(-1deg); }
  }
  .drift { animation: drift 12s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) {
    .drift { animation: none; }
  }
`;
