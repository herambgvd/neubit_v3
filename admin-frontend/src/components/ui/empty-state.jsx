import { cn } from "@/lib/cn";

// Centered empty/zero state with optional icon + action.
export function EmptyState({ icon: Icon, title, description, action, className }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-16 text-center", className)}>
      {Icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-card-border bg-card text-accent">
          <Icon className="h-5 w-5" />
        </div>
      )}
      {title && <p className="mt-4 text-sm font-medium text-foreground">{title}</p>}
      {description && <p className="mt-1 max-w-xs text-xs text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
