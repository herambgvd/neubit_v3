import {
  cloneElement,
  isValidElement,
  useId,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/cn";

export interface FieldProps {
  label?: ReactNode;
  /** Explicit control id. Omit it and the field generates one. */
  htmlFor?: string;
  /** Rendered in place of the hint when set — pass a validation message. */
  error?: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * Label + control + error/hint wrapper. Pairs with react-hook-form.
 *
 * The label is ASSOCIATED with its control: when no `htmlFor` is given the field
 * generates an id and puts it on a single element child that has none. Without
 * this the label was decorative — a screen reader announced the input as
 * unlabelled, and clicking the text did not focus it.
 *
 * A child that does not forward `id` to a DOM node (a Radix `Select` root, say)
 * cannot be associated this way; give those an explicit `htmlFor` and set the
 * matching id on the trigger.
 */
export function Field({ label, htmlFor, error, hint, required, className, children }: FieldProps) {
  const generatedId = useId();
  const controlId = htmlFor ?? generatedId;
  const control =
    isValidElement(children) && (children.props as { id?: string }).id === undefined
      ? cloneElement(children as ReactElement<{ id?: string }>, { id: controlId })
      : children;

  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <label htmlFor={controlId} className="block text-sm font-medium text-foreground">
          {label}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </label>
      )}
      {control}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Standalone label for a control laid out by hand rather than by `Field`.
 *
 * `htmlFor` and the text are REQUIRED: a label with neither is decorative markup
 * that a screen reader never reads out and a click never focuses.
 */
export function Label({
  className,
  htmlFor,
  children,
  ...props
}: ComponentPropsWithoutRef<"label"> & { htmlFor: string; children: ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn("block text-sm font-medium text-foreground", className)}
      {...props}
    >
      {children}
    </label>
  );
}
