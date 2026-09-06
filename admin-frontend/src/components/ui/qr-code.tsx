"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

import { cn } from "@/lib/cn";

export interface QrCodeProps {
  /** Usually an otpauth:// URI. Renders a placeholder while empty. */
  value: string | null | undefined;
  size?: number;
  className?: string;
}

// Renders an otpauth:// (or any) string as a QR image. White quiet-zone bg so it
// scans in both light and dark themes.
export function QrCode({ value, size = 176, className }: QrCodeProps) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let alive = true;
    if (!value) return;
    QRCode.toDataURL(value, { width: size, margin: 1, errorCorrectionLevel: "M" })
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch(() => {
        if (alive) setSrc("");
      });
    return () => {
      alive = false;
    };
  }, [value, size]);

  return (
    <div
      className={cn("inline-flex items-center justify-center rounded-lg bg-white p-2", className)}
      style={{ width: size + 16, height: size + 16 }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="QR code" width={size} height={size} />
      ) : (
        <div className="h-full w-full animate-pulse rounded bg-gray-100" />
      )}
    </div>
  );
}
