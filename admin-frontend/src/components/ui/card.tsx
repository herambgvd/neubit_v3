import type { ReactNode, ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("rounded-2xl border border-card-border bg-card", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("border-b border-card-border px-5 py-4", className)} {...props} />;
}

export function CardTitle({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"h3"> & { children: ReactNode }) {
  // An empty heading is announced as a heading with no name, which breaks a
  // screen reader's heading outline — a title-less card renders no <h3> at all.
  if (children === null || children === undefined || children === false || children === "") {
    return null;
  }
  return (
    <h3
      className={cn("text-sm font-semibold tracking-tight text-foreground", className)}
      {...props}
    >
      {children}
    </h3>
  );
}

export function CardDescription({ className, ...props }: ComponentPropsWithoutRef<"p">) {
  return <p className={cn("mt-1 text-xs text-muted", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("p-5", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("flex items-center gap-3 border-t border-card-border px-5 py-4", className)}
      {...props}
    />
  );
}
