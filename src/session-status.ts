import { FieldPacket, RowDataPacket } from "mysql2";
import whatsappClientPool from "./connection";
import { WhatsappInstanceType } from "./types";
import { logWithDate } from "./utils";

export type SessionState = "STARTING" | "QR_PENDING" | "CONNECTED" | "DISCONNECTED";
export type SessionAction = "RESTART" | "LOGOUT";

// Shape returned by GET /whatsapp/clients and /whatsapp/clients/:from/session.
// client/number/auth/ready keep the fields the endpoint always returned.
export interface SessionStatus {
  client: string;
  number: string;
  type: WhatsappInstanceType;
  auth: boolean;
  ready: boolean;
  state: SessionState;
  action: SessionAction | null;
  phone: string | null;
  pushName: string | null;
  qr: string | null;
  qrAt: string | null;
  startedAt: string;
  connectedAt: string | null;
  stateChangedAt: string;
  lastDisconnectReason: string | null;
  lastReceivedAt: string | null;
  lastSentAt: string | null;
}

export class SessionBusyError extends Error {
  constructor(public readonly action: SessionAction) {
    super(`A ${action} is already running for this instance`);
  }
}

// Accepts seconds, milliseconds, Date or protobuf Long, as each library reports time differently.
function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  let numeric: number | null = null;

  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    numeric = Number(value);
  } else if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toNumber?: unknown }).toNumber === "function"
  ) {
    numeric = (value as { toNumber: () => number }).toNumber();
  }

  if (numeric === null || !Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return new Date(numeric < 1e12 ? numeric * 1000 : numeric);
}

function latest(current: Date | null, value: unknown): Date {
  const now = new Date();
  const candidate = toDate(value) ?? now;
  // A skewed clock on the phone must not push the date into the future.
  const bounded = candidate > now ? now : candidate;

  return current && current > bounded ? current : bounded;
}

const toISO = (date: Date | null) => (date ? date.toISOString() : null);

// In-memory view of one WhatsApp session for the management panel.
export class SessionTracker {
  public state: SessionState = "STARTING";
  public action: SessionAction | null = null;
  public phone: string | null = null;
  public pushName: string | null = null;
  public qr: string | null = null;
  public qrAt: Date | null = null;
  public readonly startedAt = new Date();
  public connectedAt: Date | null = null;
  public stateChangedAt = new Date();
  public lastDisconnectReason: string | null = null;
  public lastReceivedAt: Date | null = null;
  public lastSentAt: Date | null = null;

  constructor(
    private readonly clientName: string,
    private readonly whatsappNumber: string,
    private readonly type: WhatsappInstanceType,
  ) {
    void this.loadLastReceivedAt();
  }

  private setState(state: SessionState) {
    if (this.state !== state) {
      this.state = state;
      this.stateChangedAt = new Date();
    }
  }

  public starting() {
    this.qr = null;
    this.qrAt = null;
    this.connectedAt = null;
    this.setState("STARTING");
  }

  public qrReceived(qr: string) {
    this.qr = qr;
    this.qrAt = new Date();
    this.connectedAt = null;
    this.setState("QR_PENDING");
  }

  // Paired but still syncing; WWEBJS reports this before "ready".
  public authenticated() {
    this.qr = null;
    this.qrAt = null;
  }

  public connected(phone?: string | null, pushName?: string | null) {
    if (this.state !== "CONNECTED" || !this.connectedAt) {
      this.connectedAt = new Date();
    }

    this.qr = null;
    this.qrAt = null;
    this.phone = phone || this.phone;
    this.pushName = pushName || this.pushName;
    this.lastDisconnectReason = null;
    this.setState("CONNECTED");
  }

  public disconnected(reason?: string | null) {
    this.qr = null;
    this.qrAt = null;
    this.connectedAt = null;
    this.lastDisconnectReason = reason || null;
    this.setState("DISCONNECTED");
  }

  // The device was unlinked, so the number it was paired with no longer applies.
  public loggedOut() {
    this.phone = null;
    this.pushName = null;
  }

  public messageReceived(timestamp?: unknown) {
    this.lastReceivedAt = latest(this.lastReceivedAt, timestamp);
  }

  public messageSent(timestamp?: unknown) {
    this.lastSentAt = latest(this.lastSentAt, timestamp);
  }

  public async runAction(action: SessionAction, run: () => Promise<void>) {
    if (this.action) {
      throw new SessionBusyError(this.action);
    }

    this.action = action;
    logWithDate(
      `[${this.clientName} - ${this.whatsappNumber}] ${action} requested from the management panel`,
    );

    try {
      await run();
    } finally {
      this.action = null;
    }
  }

  public snapshot(flags: { auth: boolean; ready: boolean }): SessionStatus {
    return {
      client: this.clientName,
      number: this.whatsappNumber,
      type: this.type,
      auth: flags.auth,
      ready: flags.ready,
      state: this.state,
      action: this.action,
      phone: this.phone,
      pushName: this.pushName,
      qr: this.qr,
      qrAt: toISO(this.qrAt),
      startedAt: this.startedAt.toISOString(),
      connectedAt: toISO(this.connectedAt),
      stateChangedAt: this.stateChangedAt.toISOString(),
      lastDisconnectReason: this.lastDisconnectReason,
      lastReceivedAt: toISO(this.lastReceivedAt),
      lastSentAt: toISO(this.lastSentAt),
    };
  }

  // Received messages are kept in the local `messages` table, so the last one
  // survives a restart of this service. Sent messages are not stored there.
  private async loadLastReceivedAt() {
    try {
      const [rows]: [RowDataPacket[], FieldPacket[]] =
        await whatsappClientPool.query(
          "SELECT MAX(`TIMESTAMP`) AS LAST_TIMESTAMP FROM messages WHERE INSTANCE = ? AND FROM_ME = 0",
          [`${this.clientName}_${this.whatsappNumber}`],
        );
      const stored = toDate(rows[0]?.["LAST_TIMESTAMP"]);

      if (stored && (!this.lastReceivedAt || stored > this.lastReceivedAt)) {
        this.lastReceivedAt = stored;
      }
    } catch (err) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Failed to load the last received message date =>`,
        err,
      );
    }
  }
}

export function waitUntil(condition: () => boolean, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (condition()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, 200);
    };
    check();
  });
}
