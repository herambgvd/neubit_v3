import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/cn";

export function Skeleton({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("animate-pulse rounded bg-hover", className)} {...props} />;
}
