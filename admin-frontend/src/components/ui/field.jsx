import { cn } from "@/lib/cn";

// Label + control + error/hint wrapper. Pairs with react-hook-form.
export function Field({ label, htmlFor, error, hint, required, className, children }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <label htmlFor={htmlFor} className="block text-sm font-medium text-foreground">
          {label}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Label({ className, ...props }) {
  return <label className={cn("block text-sm font-medium text-foreground", className)} {...props} />;
}
