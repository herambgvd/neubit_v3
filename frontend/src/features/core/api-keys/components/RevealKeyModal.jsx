"use client";

import { Icon } from "@iconify/react";

import { Button, Modal } from "@/components/ui/kit";

// Shows the freshly-created secret key once, with a copy button.
export default function RevealKeyModal({ revealed, onClose, copied, onCopy }) {
  return (
    <Modal
      open={!!revealed}
      onClose={onClose}
      title="API key created"
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-400">
          <Icon icon="heroicons-outline:exclamation-triangle" className="text-base mt-0.5 shrink-0" />
          <span>Copy this key now — you won't be able to see it again.</span>
        </div>
        <div>
          <span className="block text-sm font-medium text-muted text-muted mb-1">Secret key</span>
          <div className="flex items-stretch gap-2">
            <div className="flex-1 min-w-0 rounded-lg border border-card-border border-card-border bg-hover bg-background/40 px-3 py-2.5">
              <code className="block font-mono text-xs text-foreground text-foreground break-all">
                {revealed?.key}
              </code>
            </div>
            <Button
              variant="secondary"
              icon={copied ? "heroicons-outline:check" : "heroicons-outline:clipboard"}
              onClick={onCopy}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
