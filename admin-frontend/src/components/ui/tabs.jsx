"use client";

import { forwardRef } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/cn";

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border border-card-border bg-card p-1",
        className
      )}
      {...props}
    />
  );
});

export const TabsTrigger = forwardRef(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "rounded-md px-3 py-1.5 text-xs font-medium text-muted outline-none transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent/40 data-[state=active]:bg-hover data-[state=active]:text-foreground",
        className
      )}
      {...props}
    />
  );
});

export const TabsContent = forwardRef(function TabsContent({ className, ...props }, ref) {
  return <TabsPrimitive.Content ref={ref} className={cn("mt-4 outline-none", className)} {...props} />;
});
