import { cn } from "@/lib/cn";
import { Card } from "./card";

// KPI tile: label + value + optional icon and delta/hint line.
export function StatCard({ label, value, icon: Icon, hint, tone = "muted", className }) {
  const toneCls = {
    muted: "text-muted",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    accent: "text-accent",
  }[tone];
  return (
    <Card className={cn("p-5", className)}>
      <div className="flex items-start justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
        {Icon && <Icon className="h-4 w-4 text-muted" />}
      </div>
      <div className="mt-3 text-2xl font-semibold tabular-nums tracking-tight text-foreground">
        {value}
      </div>
      {hint && <div className={cn("mt-1 text-xs", toneCls)}>{hint}</div>}
    </Card>
  );
}
