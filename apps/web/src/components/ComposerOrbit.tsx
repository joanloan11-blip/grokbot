import { useEffect, useRef } from 'react';

/**
 * Знак Q бежит по периметру поля ввода, за ним — лаймовый хвост по рамке.
 * Пока агент работает — быстрее. При «уменьшить движение» стоит на месте.
 */
export function ComposerOrbit({ busy }: { busy: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const track = useRef<SVGPathElement>(null);
  const tail = useRef<SVGPathElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const speed = useRef(busy ? 220 : 55);

  useEffect(() => {
    speed.current = busy ? 220 : 55;
  }, [busy]);

  useEffect(() => {
    const host = box.current?.parentElement;
    const path = track.current;
    if (!host || !path || !svg.current || !tail.current || !mark.current)
      return;
    const reduce = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    let length = 0;
    const layout = () => {
      const width = host.offsetWidth;
      const height = host.offsetHeight;
      const radius = Math.min(
        Number.parseFloat(getComputedStyle(host).borderTopLeftRadius) || 20,
        height / 2,
        width / 2,
      );
      // Прямоугольник со скруглением точно по рамке (центр линии рамки).
      const x = 0.5;
      const y = 0.5;
      const w = width - 1;
      const h = height - 1;
      const r = Math.max(0, radius - 0.5);
      const d = `M ${x + r} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${y + r} V ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} H ${x + r} A ${r} ${r} 0 0 1 ${x} ${y + h - r} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
      svg.current?.setAttribute('viewBox', `0 0 ${width} ${height}`);
      path.setAttribute('d', d);
      tail.current?.setAttribute('d', d);
      length = path.getTotalLength();
    };
    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(host);

    let distance = 0;
    let last = performance.now();
    let frame = 0;
    const place = () => {
      if (!length) return;
      const at = ((distance % length) + length) % length;
      const point = path.getPointAtLength(at);
      if (mark.current)
        mark.current.style.transform = `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)`;
      // Хвост — отрезок рамки позади знака.
      const trail = Math.min(140, length / 3);
      if (tail.current) {
        tail.current.style.strokeDasharray = `${trail} ${length}`;
        tail.current.style.strokeDashoffset = `${trail - at}`;
      }
    };
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      distance += speed.current * dt;
      place();
    };
    if (reduce) place();
    else frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      className={busy ? 'composer-orbit busy' : 'composer-orbit'}
      ref={box}
      aria-hidden="true"
    >
      <svg ref={svg} preserveAspectRatio="none">
        <path ref={track} className="orbit-track" />
        <path ref={tail} className="orbit-tail" />
      </svg>
      <span ref={mark} className="orbit-q">
        Q
      </span>
    </div>
  );
}
