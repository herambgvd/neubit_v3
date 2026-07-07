"use client";

import { Button, Card } from "@/components/ui/kit";

// Compact relative time for the notification feed. Kept local (not @/lib/format's
// fmtRelative) to preserve the exact "just now / 5m / 3h / 2d ago" wording.
function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleString();
}

export function NotificationItem({ notification, onMarkRead, marking }) {
  const n = notification;
  return (
    <Card
      className={`p-4 flex items-start justify-between gap-4 ${
        n.read ? "" : "border-l-2 !border-l-foreground bg-hover"
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {!n.read && <span className="h-2 w-2 rounded-full bg-blue-600 shrink-0" />}
          <p className="font-medium text-foreground text-foreground truncate">{n.title}</p>
        </div>
        {n.body && <p className="text-sm text-muted text-muted mt-1">{n.body}</p>}
        <p className="text-xs text-muted mt-2">{formatTime(n.ts)}</p>
      </div>
      {!n.read && (
        <Button
          variant="ghost"
          icon="heroicons-outline:check"
          disabled={marking}
          onClick={() => onMarkRead(n.id)}
        >
          Mark read
        </Button>
      )}
    </Card>
  );
}
