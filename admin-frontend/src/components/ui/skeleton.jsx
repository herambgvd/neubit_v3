import { cn } from "@/lib/cn";

export function Skeleton({ className, ...props }) {
  return <div className={cn("animate-pulse rounded bg-hover", className)} {...props} />;
}
