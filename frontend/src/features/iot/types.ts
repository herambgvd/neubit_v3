// Wire types for the IoT fleet surface, served by the reading-writer under
// /api/v1/iot (backend/reading-writer/app/api/iot.py).
//
// These mirror conflux's OWN gateway shape rather than re-spelling it. The
// backend passes it through unchanged on purpose: translating it would create
// two definitions of a gateway, and the one nobody maintains is the one a
// console renders.

/** What a gateway has CONFIGURED for one connection, plus what reached us. */
export interface IotConnection {
  id: string;
  slug: string;
  name: string;
  proto: string;
  /** Devices the gateway has configured on this connection. */
  devices: number;
  /** Points the gateway has configured on this connection. */
  points: number;
  /**
   * What this platform has actually received. Deliberately NOT merged into
   * `devices`/`points` above: those are the gateway's configuration and these
   * are our receipts, and the gap between them is the finding — a connection
   * configured with 437 points that delivered 436 has one point that has never
   * published, which neither side can see alone.
   */
  arrived: {
    devices: number;
    points: number;
    /** ISO timestamp of the newest reading on this connection, or null. */
    last_seen_at: string | null;
  };
}

export interface IotGatewayStats {
  published: number;
  dropped: number;
  buffered: number;
  outboxDepth: number;
}

export interface IotGatewayCounts {
  connections: number;
  devices: number;
  points: number;
}

export interface IotGateway {
  gatewayId: string;
  /** The gateway's self-reported hostname. `label` overrides it for display. */
  name: string;
  version: string;
  health: string;
  uptimeSec: number;
  stats: IotGatewayStats;
  counts: IotGatewayCounts;
  /**
   * NULL is not an empty list. It means the gateway runs a build that cannot
   * report its connections, so the console must say "unknown" rather than
   * "this gateway has none" — a much more alarming and quite different claim.
   */
  connections: IotConnection[] | null;
  /** Operator-owned metadata, set on the gateway server and never here. */
  label: string;
  site: string;
  notes: string;
  tags: string[];
  /** Enrolment lifecycle: pending | approved | revoked. */
  state: string;
  /** Computed by the gateway server from its last heartbeat. */
  status: string;
  lastSeenSec: number;
  tenantId?: string;
  isSelf?: boolean;
}

/** Counters from the platform's own sync loop, for the "as of" line. */
export interface IotSyncStats {
  syncs: number;
  failures: number;
  gateways: number;
  connections: number;
  points_stamped: number;
  last_error: string;
}

export interface IotGatewayList {
  gateways: IotGateway[];
  sync: IotSyncStats | null;
}

/** One row of the points table under a gateway. */
export interface IotPoint {
  point_id: string;
  device_tag: string | null;
  point_tag: string | null;
  unit: string | null;
  category: string | null;
  device_type: string | null;
  last_seen_at: string | null;
  retired_at: string | null;
  /**
   * Whether this point still counts. Computed by the SERVER, from explicit
   * retirement OR the silence horizon — a client that re-derived it would
   * disagree the moment somebody changed the horizon.
   */
  live: boolean;
  /**
   * The most recent reading inside the server's lookback window, or null.
   *
   * NULL means "nothing recent", never "zero". A point silent longer than the
   * window reports no value at all rather than an hours-old number rendered as
   * live — the same rule the Building Intelligence screens follow.
   */
  latest: { ts: string; num: number | null; txt: string | null; quality: number } | null;
}

export interface IotPointList {
  gateway_id: string;
  points: IotPoint[];
  /** The silence horizon, in days, so the console can say why in real units. */
  retire_after_days: number;
  /** How far back a "current value" may be read. Why a dash is a dash. */
  value_lookback_minutes: number;
}

/** One fault the gateway raised, as the platform holds it. */
export interface IotAlert {
  alert_id: string;
  /** When it was RAISED. */
  ts: string;
  severity: string | null;
  alert_type: string | null;
  device_tag: string | null;
  point_addr: string | null;
  message: string | null;
  device_category: string | null;
  /**
   * What the alert IS now: "acked", "open", or null.
   *
   * NULL is a third state and not a synonym for open: it means the alert
   * predates the acknowledgement wire, so nobody ever said. The console shows
   * it as unknown, because calling it open would be inventing a fact about
   * whether somebody dealt with it.
   */
  ack_state: string | null;
  /**
   * When it was LAST acknowledged, which is history rather than state. An
   * alert closed at 14:02 and reopened at 14:40 carries `open` AND this
   * timestamp, and both are true. Reading this as "acknowledged" is wrong.
   */
  acked_at: string | null;
}

export interface IotAlertList {
  gateway_id: string;
  alerts: IotAlert[];
}

/** One enrolment token the gateway server has issued. */
export interface IotEnrollToken {
  id: string;
  name: string;
  tenantId?: string;
  createdAt: number;
  /** 0 = never used to enrol anything. */
  lastUsed: number;
  /**
   * Revoked tokens are KEPT, not deleted. Which token admitted which gateway
   * has to stay traceable, so revoking marks the row rather than removing it —
   * a list that hid them would lose that trail.
   */
  revoked: boolean;
}

/**
 * The reply to a mint. `secret` is the plaintext credential and exists ONLY
 * here — the gateway server stores a bcrypt hash, so this response is the only
 * copy that will ever be readable. Optional because a server that declined to
 * return one must be reported rather than rendered as an empty box.
 */
export interface IotMintedToken extends IotEnrollToken {
  secret?: string;
}
