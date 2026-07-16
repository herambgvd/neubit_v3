import { cn } from "@/lib/cn";

export function Card({ className, ...props }) {
  return (
    <div
      className={cn("rounded-2xl border border-card-border bg-card", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }) {
  return <div className={cn("border-b border-card-border px-5 py-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }) {
  return (
    <h3
      className={cn("text-sm font-semibold tracking-tight text-foreground", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }) {
  return <p className={cn("mt-1 text-xs text-muted", className)} {...props} />;
}

export function CardContent({ className, ...props }) {
  return <div className={cn("p-5", className)} {...props} />;
}

export function CardFooter({ className, ...props }) {
  return (
    <div
      className={cn("flex items-center gap-3 border-t border-card-border px-5 py-4", className)}
      {...props}
    />
  );
}
