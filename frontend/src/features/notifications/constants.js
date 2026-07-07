// Config fields per channel — the shape the backend expects under `config`.
export const CHANNEL_FIELDS = {
  email: [
    { key: "host", label: "SMTP host", placeholder: "smtp.example.com" },
    { key: "port", label: "Port", placeholder: "587" },
    { key: "username", label: "Username", placeholder: "no-reply@example.com" },
    { key: "password", label: "Password", type: "password" },
    { key: "from_addr", label: "From address", placeholder: "Neubit <no-reply@example.com>" },
    { key: "use_tls", label: "Use TLS", type: "bool" },
  ],
  push: [{ key: "server_key", label: "FCM server key", type: "password" }],
  webhook: [
    { key: "url", label: "Endpoint URL", placeholder: "https://hooks.example.com/neubit" },
    { key: "secret", label: "Signing secret", type: "password" },
  ],
};

export const CHANNEL_META = {
  email: { title: "Email (SMTP)", icon: "heroicons-outline:envelope" },
  push: { title: "Push (FCM)", icon: "heroicons-outline:device-phone-mobile" },
  webhook: { title: "Webhook", icon: "heroicons-outline:bolt" },
};
