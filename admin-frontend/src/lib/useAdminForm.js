"use client";

import { useForm } from "react-hook-form";
import { yupResolver } from "@hookform/resolvers/yup";

/**
 * Thin wrapper over react-hook-form with a yup schema resolver and sensible
 * admin-console defaults (validate on submit + blur, then keep re-validating).
 *
 *   const form = useAdminForm(schema, { name: "", email: "" });
 *   <Input {...form.register("name")} invalid={!!form.formState.errors.name} />
 */
export function useAdminForm(schema, defaultValues) {
  return useForm({
    resolver: schema ? yupResolver(schema) : undefined,
    defaultValues,
    mode: "onTouched",
    reValidateMode: "onChange",
  });
}
