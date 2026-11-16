import QRCode from 'qrcode';
import { useMemo, type ReactNode } from 'react';

const QUIET_ZONE = 4;

/** Draws the code as vector shapes in the page itself: no image file, nothing sent anywhere. */
export function Qr({ value, label }: { value: string; label: string }): ReactNode {
  const { path, size } = useMemo(() => {
    const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' });
    let d = '';
    for (let y = 0; y < modules.size; y += 1) {
      for (let x = 0; x < modules.size; x += 1) {
        if (modules.data[y * modules.size + x]) d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
      }
    }
    return { path: d, size: modules.size + QUIET_ZONE * 2 };
  }, [value]);

  return (
    <svg
      className="qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
