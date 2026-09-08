// Config fields per channel — the shape the backend expects under `config`.
//
// CHANNEL_META is also the LIST: a channel the backend reports but this file does
// not name is not offered (see Channels.tsx). That is how the webhook channel was
// retired without a backend migration — core still carries the transport, nothing
// in the product ever calls it, so the console stopped offering to configure it.

/** One editable key of a channel's `config` dict. */
export interface ChannelField {
  key: string;
  label: string;
  placeholder?: string;
  /** "password" is write-only (masked "***" on read); "bool" renders a toggle. */
  type?: "text" | "password" | "bool";
}

export const CHANNEL_FIELDS: Record<string, ChannelField[]> = {
  email: [
    { key: "host", label: "SMTP host", placeholder: "smtp.example.com" },
    { key: "port", label: "Port", placeholder: "587" },
    { key: "username", label: "Username", placeholder: "no-reply@example.com" },
    { key: "password", label: "Password", type: "password" },
    { key: "from_addr", label: "From address", placeholder: "Neubit <no-reply@example.com>" },
    { key: "use_tls", label: "Use TLS", type: "bool" },
  ],
  push: [{ key: "server_key", label: "FCM server key", type: "password" }],
};

export const CHANNEL_META: Record<string, { title: string; icon: string }> = {
  email: { title: "Email (SMTP)", icon: "heroicons-outline:envelope" },
  push: { title: "Push (FCM)", icon: "heroicons-outline:device-phone-mobile" },
};
