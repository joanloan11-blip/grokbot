import { useEffect, useRef } from 'react';

const GLYPHS =
  'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789ABCDEFQASTOM<>{}=+*';

/**
 * «Матрица» в окне размышлений: лаймовые символы стекают сверху, как штора.
 * Рисуется на canvas под текстом; при «уменьшить движение» не анимируется.
 */
export function MatrixRain({
  className = 'matrix-rain',
}: {
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduce = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    const size = 14;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;
    let drops: number[] = [];
    let speeds: number[] = [];
    let color = '#c6f432';
    let bg = '#131411';

    const readColors = () => {
      const style = getComputedStyle(canvas);
      color = style.getPropertyValue('--accent').trim() || color;
      bg = style.getPropertyValue('--bg-2').trim() || bg;
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const columns = Math.ceil(width / size);
      drops = Array.from(
        { length: columns },
        (_, i) => drops[i] ?? Math.random() * (height / size),
      );
      speeds = Array.from(
        { length: columns },
        (_, i) => speeds[i] ?? 0.6 + Math.random() * 0.7,
      );
      readColors();
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    let frame = 0;
    let last = 0;
    const draw = (time: number) => {
      frame = requestAnimationFrame(draw);
      if (time - last < 50) return; // ~20 кадров в секунду — хватает и не грузит ноутбук
      last = time;
      // Полупрозрачная заливка оставляет «хвосты» у падающих символов.
      ctx.globalAlpha = 0.09;
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
      ctx.font = `${size - 1}px "JetBrains Mono", monospace`;
      for (let i = 0; i < drops.length; i++) {
        const y = drops[i]! * size;
        const glyph = GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!;
        // Голова струи светлее, остальное — лайм.
        ctx.fillStyle = Math.random() > 0.92 ? '#f4ffd6' : color;
        ctx.fillText(glyph, i * size, y);
        drops[i]! += speeds[i]!;
        if (y > height && Math.random() > 0.9) drops[i] = -Math.random() * 4;
      }
    };
    if (reduce) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = color;
      ctx.font = `${size - 1}px "JetBrains Mono", monospace`;
      for (let i = 0; i < drops.length; i++)
        for (let row = 0; row < height / size; row += 3)
          ctx.fillText(
            GLYPHS[(i * 7 + row) % GLYPHS.length]!,
            i * size,
            row * size,
          );
    } else frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
