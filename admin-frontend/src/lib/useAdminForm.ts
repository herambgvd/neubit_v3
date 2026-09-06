"use client";

import {
  useForm,
  type DefaultValues,
  type FieldValues,
  type Resolver,
  type UseFormReturn,
} from "react-hook-form";
import { yupResolver } from "@hookform/resolvers/yup";
import type { ObjectSchema } from "yup";

/**
 * Thin wrapper over react-hook-form with a yup schema resolver and sensible
 * admin-console defaults (validate on submit + blur, then keep re-validating).
 *
 *   const form = useAdminForm(schema, { name: "", email: "" });
 *   <Input {...form.register("name")} invalid={!!form.formState.errors.name} />
 *
 * The schema drives the field types: `useAdminForm(tenantSchema, …)` returns a
 * form whose `register("…")` only accepts that schema's keys.
 */
export function useAdminForm<T extends FieldValues>(
  schema: ObjectSchema<T> | undefined,
  defaultValues?: DefaultValues<T>
): UseFormReturn<T> {
  return useForm<T>({
    // The cast is the known gap in @hookform/resolvers' yup types: a yup schema
    // whose output is T does not structurally satisfy Resolver<T> because yup
    // widens optional keys. Behaviour is unchanged; only the generic is coerced.
    resolver: schema ? (yupResolver(schema) as unknown as Resolver<T>) : undefined,
    defaultValues,
    mode: "onTouched",
    reValidateMode: "onChange",
  });
}
