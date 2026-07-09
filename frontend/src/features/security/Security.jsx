"use client";

// Config → Security (P6-D). The enterprise security admin surface, gated on
// security.manage: 2FA-enforcement policy, LDAP/AD directory, OIDC SSO, and the
// four-eyes dual-authorization ledger. Each section binds to /api/v1/security/*
// on the core service. Personal 2FA enrollment lives under My account → Security.
import Link from "next/link";
import { Icon } from "@iconify/react";

import { PageHeader } from "@/components/ui/kit";
import { useAuth } from "@/lib/auth";
import PolicyCard from "./components/PolicyCard";
import DirectoryCard from "./components/DirectoryCard";
import SsoCard from "./components/SsoCard";
import DualAuthPanel from "./components/DualAuthPanel";

export default function SecurityPage() {
  const { can } = useAuth();
  const canManage = can("security.manage");
  const canApprove = can("dualauth.approve");

  // No visibility at all → a clean gate (the nav tab is also perm-hidden).
  if (!canManage && !canApprove) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Icon icon="heroicons-outline:lock-closed" className="mb-3 text-4xl text-muted opacity-50" />
        <p className="font-medium text-foreground">Security settings are restricted</p>
        <p className="mt-1 text-sm text-muted">You need the security.manage or dualauth.approve permission.</p>
      </div>
    );
  }

  return (
    <div className="pb-8">
      <PageHeader
        title="Security"
        subtitle="Enterprise authentication & governance — 2FA enforcement, directory & SSO integration, and four-eyes approvals."
      />

      {/* Personal 2FA pointer — enrollment lives in My account. */}
      <div className="mb-4 flex items-center gap-3 rounded-xl border border-card-border bg-card px-4 py-3">
        <Icon icon="heroicons-outline:device-phone-mobile" className="text-lg text-muted" />
        <div className="flex-1 text-sm">
          <span className="text-foreground">Set up your own two-factor authenticator</span>
          <span className="text-muted"> — enroll or manage recovery codes in your account.</span>
        </div>
        <Link
          href="/account"
          className="rounded-md border border-card-border px-3 py-1.5 text-sm text-foreground transition hover:bg-hover"
        >
          My account
        </Link>
      </div>

      <div className="space-y-4">
        {canManage && <PolicyCard canManage={canManage} />}
        {canManage && <DirectoryCard canManage={canManage} />}
        {canManage && <SsoCard canManage={canManage} />}
        <DualAuthPanel />
      </div>
    </div>
  );
}
