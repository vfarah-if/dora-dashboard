import type { Band } from "@dora-dashboard/core";

const LEVEL: Record<Band, number> = { elite: 4, high: 3, medium: 2, low: 1 };

/**
 * A four-bar meter whose filled bar count states the band, so a band is carried by shape as well as
 * colour and text. Decorative, because the band name is always printed beside it.
 */
export function BandIcon({ band }: { band: Band }) {
  const level = LEVEL[band];
  return (
    <svg className={`band-icon band-${band}`} width="18" height="14" viewBox="0 0 18 14" aria-hidden="true" focusable="false">
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={i * 4.5}
          y={10 - i * 3}
          width="3"
          height={4 + i * 3}
          rx="1"
          className={i < level ? "band-icon-on" : "band-icon-off"}
        />
      ))}
    </svg>
  );
}
