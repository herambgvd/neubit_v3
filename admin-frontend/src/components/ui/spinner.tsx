import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin text-muted", className)} />;
}

// Full-area loading placeholder.
export function LoadingBlock({
  label = "Loading…",
  className,
}: {
  label?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-center gap-2 py-16 text-sm text-muted", className)}>
      <Spinner /> {label}
    </div>
  );
}
