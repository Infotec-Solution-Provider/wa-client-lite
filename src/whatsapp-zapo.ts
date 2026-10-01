import "dotenv/config";
import axios from "axios";
import { extension } from "mime-types";
import {
  ConnectionOptions,
  FieldPacket,
  Pool,
  RowDataPacket,
  createPool,
} from "mysql2/promise";
import { schedule } from "node-cron";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMysqlStore } from "@zapo-js/store-mysql";
import {
  ConsoleLogger,
  createStore,
  proto,
  toUserJid,
  WaClient,
  type LogLevel,
  type Proto,
  type WaConnectionEvent,
  type WaIncomingMessageEvent,
  type WaIncomingReceiptEvent,
  type WaOutgoingMessageEvent,
  type WaSendMessageContent,
  type WaStore,
} from "zapo-js";
import whatsappClientPool from "./connection";
import loadAvatars from "./functions/loadAvatars";
import Log from "./log";
import { SessionTracker, waitUntil } from "./session-status";
import { ParsedMessage, SendFileOptions } from "./types";
import {
  encodeParsedMessage,
  formatToOpusAudio,
  logWithDate,
  mapToParsedMessage,
  validatePhoneStr,
} from "./utils";
import {
  getJidUser,
  getPhoneFromZapoJid,
  mapZapoReceiptStatus,
  parseZapoMessage,
  resolveZapoContactNumber,
  type LegacyReceiptStatus,
  type ZapoContactNumberSource,
  type ZapoMediaDescriptor,
  type ZapoParsedContent,
} from "./zapo-message";
import {
  getOggOpusDurationSeconds,
  transcodeToVoiceNote,
  VOICE_NOTE_MIMETYPE,
} from "./voice-note";

const filesPath = process.env["FILES_DIRECTORY"]!;
const RECONNECT_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 240_000];
const LOGOUT_CLEAR_TIMEOUT_MS = 15_000;
const MAX_TRACKED_OUTGOING_EVENTS = 500;
const MAX_MEDIA_BYTES =
  Number(process.env["ZAPO_MAX_MEDIA_BYTES"]) || 50 * 1024 * 1024;

interface ResolvedContact {
  contactNumber: string;
  source: ZapoContactNumberSource;
}

interface ZapoQuote {
  id: string;
  remoteJid: string;
  fromMe: boolean;
  participant?: string;
  message?: Proto.IMessage;
}

function resolveLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "trace" ||
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error"
  ) {
    return normalized;
  }
  return "warn";
}

const zapoLogger = new ConsoleLogger(
  resolveLogLevel(process.env["ZAPO_LOG_LEVEL"]),
);

// Same fallback chain as the Baileys auth state, so an existing BAILEYS_AUTH_DB_*
// setup works without new variables. The zapo tables need MySQL 5.7+ (utf8mb4 keys).
function getZapoStoreConnection() {
  return {
    host:
      process.env["ZAPO_DB_HOST"] ||
      process.env["BAILEYS_AUTH_DB_HOST"] ||
      process.env["DATABASE_HOST"] ||
      "localhost",
    port:
      Number(
        process.env["ZAPO_DB_PORT"] ||
          process.env["BAILEYS_AUTH_DB_PORT"] ||
          process.env["DATABASE_PORT"],
      ) || 3306,
    user:
      process.env["ZAPO_DB_USER"] ||
      process.env["BAILEYS_AUTH_DB_USER"] ||
      process.env["DATABASE_USER"] ||
      "root",
    password:
      process.env["ZAPO_DB_PASS"] ??
      process.env["BAILEYS_AUTH_DB_PASS"] ??
      process.env["DATABASE_PASSWORD"] ??
      "",
    database:
      process.env["ZAPO_DB_NAME"] ||
      process.env["BAILEYS_AUTH_DB_NAME"] ||
      process.env["DATABASE_DATABASE"] ||
      "baileys_auth",
    charset: "utf8mb4",
  };
}

class WhatsappZapoInstance {
  public readonly requestURL: string;
  public client: WaClient | null = null;
  public readonly clientName: string;
  public readonly whatsappNumber: string;
  public readonly pool: Pool;
  public isAuthenticated: boolean = false;
  public isReady: boolean = false;
  public connectionParams: ConnectionOptions;
  public blockedNumbers: Array<string> = [];
  private readonly sessionId: string;
  private store: WaStore | null = null;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private inboundChain: Promise<void> = Promise.resolve();
  private contactQueues: Map<string, Array<() => Promise<void>>> = new Map();
  private contactProcessing: Map<string, boolean> = new Map();
  private readonly outgoingEvents = new Map<string, WaOutgoingMessageEvent>();
  public readonly session: SessionTracker;

  constructor(
    clientName: string,
    whatsappNumber: string,
    requestURL: string,
    connection: ConnectionOptions,
  ) {
    this.clientName = clientName;
    this.whatsappNumber = whatsappNumber;
    this.requestURL = requestURL;
    this.connectionParams = connection;
    this.sessionId = `${clientName}_${whatsappNumber}`;
    this.session = new SessionTracker(clientName, whatsappNumber, "ZAPO");

    schedule(process.env["CRON_LOAD_AVATARS"] || "0 */4 * * *", async () => {
      try {
        await this.loadAvatars();
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Avatars loaded successfully.`,
        );
      } catch (err: any) {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Avatars loading failure =>`,
          err,
        );
      }
    });

    schedule(process.env["CRON_SYNC_MESSAGES"] || "*/2 * * * *", () =>
      this.syncMessagesWithServer(),
    );

    this.buildBlockedNumbers();
    this.pool = createPool(this.connectionParams);

    this.initialize();
  }

  private async processContactQueue(contactNumber: string, type: string) {
    if (this.contactProcessing.get(contactNumber)) return;

    this.contactProcessing.set(contactNumber, true);

    while (this.contactQueues.get(contactNumber)?.length) {
      const task = this.contactQueues.get(contactNumber)!.shift();
      if (task) {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Processing ${type} for ${contactNumber}...`,
        );
        await task();
      }
    }

    this.contactProcessing.set(contactNumber, false);
  }

  private enqueueProcessing(
    task: () => Promise<void>,
    type: string,
    contactNumber: string,
  ) {
    if (!this.contactQueues.has(contactNumber)) {
      this.contactQueues.set(contactNumber, []);
      this.contactProcessing.set(contactNumber, false);
    }

    this.contactQueues.get(contactNumber)!.push(task);
    this.processContactQueue(contactNumber, type);
  }

  private async buildBlockedNumbers() {
    const [rows]: [RowDataPacket[], FieldPacket[]] =
      await whatsappClientPool.query(
        `SELECT * FROM blocked_numbers WHERE instance_number = ?`,
        [this.whatsappNumber],
      );

    this.blockedNumbers = rows.map((r) => r["blocked_number"] as string);
  }

  public async initialize() {
    try {
      await axios.put(`${this.requestURL}/init/${this.whatsappNumber}`);
      logWithDate(`[${this.clientName} - ${this.whatsappNumber}] Init success!`);
    } catch (err: any) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Init failure =>`,
        err.response
          ? err.response.status
          : err.request
            ? err.request._currentUrl
            : err,
      );
    }

    this.startClient();
  }

  private getStore(): WaStore {
    if (this.store) return this.store;

    const backend =
      process.env["ZAPO_STORE"]?.trim().toLowerCase() === "sqlite"
        ? this.createSqliteBackend()
        : this.createMysqlBackend();

    this.store = createStore({
      backends: { db: backend },
      providers: {
        auth: "db",
        signal: "db",
        preKey: "db",
        session: "db",
        identity: "db",
        senderKey: "db",
        appState: "db",
        messages: "db",
        threads: "db",
        contacts: "db",
        privacyToken: "db",
      },
      cacheProviders: {
        retry: "db",
        groupMetadata: "db",
        chatMetadata: "db",
        deviceList: "db",
        messageSecret: "db",
      },
    });

    return this.store;
  }

  private createMysqlBackend() {
    const connection = getZapoStoreConnection();
    logWithDate(
      `[${this.clientName} - ${this.whatsappNumber}] Zapo session store: MySQL ${connection.host}:${connection.port}/${connection.database} (set ZAPO_STORE=sqlite for MySQL older than 5.7)`,
    );

    const mysqlStore = createMysqlStore({
      pool: connection,
      tablePrefix: process.env["ZAPO_TABLE_PREFIX"] || "zapo_",
      logger: zapoLogger,
      cleanup: {
        enabled: true,
        onError: (error) => {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Zapo store cleanup failed =>`,
            error,
          );
        },
      },
    });
    mysqlStore.startCleanup(this.sessionId);

    return mysqlStore;
  }

  // One file per session, for machines whose MySQL cannot hold the zapo tables
  // (utf8mb4 keys need 5.7+). Loaded on demand because better-sqlite3 is an
  // optional native dependency; without it the store falls back to node:sqlite.
  private createSqliteBackend() {
    const { createSqliteStore } =
      require("@zapo-js/store-sqlite") as typeof import("@zapo-js/store-sqlite");
    const sessionsDir =
      process.env["ZAPO_SQLITE_DIR"] || join(process.cwd(), "zapo-sessions");
    const sessionFile = join(sessionsDir, `${this.sessionId}.sqlite`);
    mkdirSync(sessionsDir, { recursive: true });
    logWithDate(
      `[${this.clientName} - ${this.whatsappNumber}] Zapo session store: SQLite ${sessionFile}`,
    );

    return createSqliteStore({ path: sessionFile, logger: zapoLogger });
  }

  private startClient() {
    this.session.starting();

    // A restart can land while a reconnect from a logout is still scheduled.
    const previousClient = this.client;
    if (previousClient) {
      previousClient.removeAllListeners();
      void previousClient.disconnect().catch(() => undefined);
    }

    const client = new WaClient(
      {
        store: this.getStore(),
        sessionId: this.sessionId,
        recoverFromClientTooOld: true,
        markOnlineOnConnect: process.env["ZAPO_MARK_ONLINE_ON_CONNECT"] === "true",
        history: { enabled: true },
      },
      zapoLogger,
    );

    this.client = client;
    this.bindEvents(client);
    this.connect(client);
  }

  private connect(client: WaClient) {
    client.connect().catch((err: unknown) => {
      if (client !== this.client) return;

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Connection failed =>`,
        err,
      );
      this.scheduleReconnect(client);
    });
  }

  private scheduleReconnect(client: WaClient) {
    if (client !== this.client || this.reconnectTimer) return;

    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)
      ]!;
    this.reconnectAttempts++;

    logWithDate(
      `[${this.clientName} - ${this.whatsappNumber}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (client !== this.client) return;
      this.connect(client);
    }, delay);
  }

  private bindEvents(client: WaClient) {
    client.on("auth_qr", (event) => {
      if (client !== this.client) return;
      void this.onQr(event.qr);
    });

    // QR refresh budget exhausted: restart the pairing so the CRM keeps getting codes.
    client.on("auth_pairing_required", (event) => {
      if (client !== this.client || !event.forceManual) return;
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] QR codes expired. Restarting pairing...`,
      );
      this.reconnectAttempts = 0;
      void client.disconnect().catch(() => undefined);
    });

    client.on("connection", (event) => {
      if (client !== this.client) return;
      void this.onConnection(client, event);
    });

    client.on("message", (event) => {
      if (client !== this.client) return;
      this.onReceiveMessage(event);
    });

    client.on("receipt", (event) => {
      if (client !== this.client) return;
      this.onReceiveMessageStatus(event);
    });

    client.on("message_send", (event) => {
      if (!event.id) return;
      if (this.outgoingEvents.size >= MAX_TRACKED_OUTGOING_EVENTS) {
        const oldest = this.outgoingEvents.keys().next().value;
        if (oldest) this.outgoingEvents.delete(oldest);
      }
      this.outgoingEvents.set(event.id, event);
    });
  }

  private async onQr(qr: string) {
    this.isAuthenticated = false;
    this.isReady = false;
    this.session.qrReceived(qr);

    try {
      await axios.post(`${this.requestURL}/qr/${this.whatsappNumber}`, { qr });
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] QR success => ${qr.slice(0, 30)}...`,
      );
    } catch (err: any) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] QR failure =>`,
        err?.response
          ? err.response.status
          : err.request
            ? err.request._currentUrl
            : err,
      );
    }
  }

  private async onConnection(client: WaClient, event: WaConnectionEvent) {
    if (event.status === "open") {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectAttempts = 0;
      this.isAuthenticated = true;
      this.isReady = true;

      const credentials = client.getCredentials();
      const connectedNumber = getJidUser(credentials?.meJid);
      this.session.connected(
        connectedNumber,
        credentials?.pushName || credentials?.meDisplayName,
      );
      if (connectedNumber && connectedNumber !== this.whatsappNumber) {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Warning: the paired phone is ${connectedNumber}, not the configured instance number.`,
        );
      }

      try {
        await axios.post(`${this.requestURL}/auth/${this.whatsappNumber}`, {});
        logWithDate(`[${this.clientName} - ${this.whatsappNumber}] Auth success!`);
      } catch (err: any) {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Auth failure =>`,
          err?.response
            ? err.response.status
            : err.request
              ? err.request._currentUrl
              : err,
        );
      }

      try {
        await axios.put(`${this.requestURL}/ready/${this.whatsappNumber}`);
        logWithDate(`[${this.clientName} - ${this.whatsappNumber}] Ready success!`);
      } catch (err: any) {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Ready failure =>`,
          err?.response
            ? err.response.status
            : err.request
              ? err.request._currentUrl
              : err,
        );
      }
      return;
    }

    this.isReady = false;
    this.isAuthenticated = false;
    this.session.disconnected(
      `${event.reason || "Connection closed"} (code ${event.code ?? "none"})`,
    );

    logWithDate(
      `[${this.clientName} - ${this.whatsappNumber}] Connection closed (code: ${event.code}, reason: ${event.reason}, logout: ${event.isLogout})`,
    );

    if (event.isLogout) {
      this.session.loggedOut();
      await this.restartAfterLogout(client);
      return;
    }

    this.scheduleReconnect(client);
  }

  // The device was unlinked: wipe the session so the next client asks for a new QR
  // instead of retrying the revoked credentials in a loop.
  private async restartAfterLogout(client: WaClient) {
    const deadline = Date.now() + LOGOUT_CLEAR_TIMEOUT_MS;
    while (client.getCredentials() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (client !== this.client) return;
    this.client = null;
    await client.disconnect().catch(() => undefined);
    client.removeAllListeners();

    try {
      await this.clearStoredSession();
    } catch (err) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Failed to clear the logged out session =>`,
        err,
      );
    }

    logWithDate(
      `[${this.clientName} - ${this.whatsappNumber}] Logged out. Starting a new session for QR pairing...`,
    );
    this.reconnectAttempts = 0;
    setTimeout(() => this.startClient(), RECONNECT_DELAYS_MS[0]);
  }

  // Keeps the mailbox (messages, threads, contacts) so quotes and LID lookups still work.
  private async clearStoredSession() {
    const session = this.getStore().session(this.sessionId);
    await Promise.all([
      session.auth.clear(),
      session.signal.clear(),
      session.preKey.clear(),
      session.session.clear(),
      session.identity.clear(),
      session.senderKey.clear(),
      session.appState.clear(),
      session.retry.clear(),
      session.groupMetadata.clear(),
      session.chatMetadata.clear(),
      session.deviceList.clear(),
      session.messageSecret.clear(),
      session.privacyToken.clear(),
    ]);
    await session.destroy();
  }

  public getSessionStatus() {
    return this.session.snapshot({
      auth: this.isAuthenticated,
      ready: this.isReady,
    });
  }

  // Detaches the current client first, so its close event does not schedule a reconnect.
  private async detachClient() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const client = this.client;
    this.client = null;
    this.isReady = false;
    this.isAuthenticated = false;

    if (client) {
      await client.disconnect().catch(() => undefined);
      client.removeAllListeners();
    }
  }

  // Reconnects with the stored session; no new QR is needed.
  public async restart() {
    await this.session.runAction("RESTART", async () => {
      await this.detachClient();
      this.reconnectAttempts = 0;
      this.startClient();
    });
  }

  // Unlinks the device from the phone, wipes the session and starts a new QR pairing.
  public async logout() {
    await this.session.runAction("LOGOUT", async () => {
      const client = this.client;

      if (client && this.isReady && client.getCredentials()?.meJid) {
        try {
          // The server closes the socket next; onConnection wipes the session and pairs again.
          await client.logout();

          if (
            await waitUntil(
              () => this.client !== client,
              LOGOUT_CLEAR_TIMEOUT_MS + 5_000,
            )
          ) {
            return;
          }

          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] The server did not close the session after logout; clearing it locally.`,
          );
        } catch (err) {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Logout request failed; clearing the local session anyway =>`,
            err,
          );
        }
      }

      await this.detachClient();

      try {
        await this.clearStoredSession();
      } finally {
        this.session.loggedOut();
        this.reconnectAttempts = 0;
        this.startClient();
      }
    });
  }

  private getReadyClient(): WaClient {
    if (!this.client) throw new Error("Client not connected");
    if (!this.isReady || !this.isAuthenticated) {
      throw new Error("Connection not ready. Please wait for authentication.");
    }
    return this.client;
  }

  private onReceiveMessage(event: WaIncomingMessageEvent) {
    const { key } = event;

    if (!event.message || key.fromMe) return;
    if (key.isGroup || key.isBroadcast || key.isNewsletter) return;
    if (key.remoteJid === "status@broadcast") return;

    const content = parseZapoMessage(event.message);
    if (!content) return;

    this.session.messageReceived(event.timestampSeconds);

    // Number lookups are async; chaining them keeps the arrival order per contact.
    this.inboundChain = this.inboundChain
      .then(async () => {
        const resolved = await this.resolveContactNumber(event);

        if (!resolved) {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Ignoring incoming message ${key.id}: no phone number could be resolved.`,
          );
          return;
        }

        if (resolved.source !== "remoteJid") {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Resolved contact number for incoming message ${key.id} via ${resolved.source}.`,
          );
        }

        this.enqueueProcessing(
          () => this.processIncomingMessage(event, content, resolved),
          "message",
          resolved.contactNumber,
        );
      })
      .catch((err) => {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Incoming message ${key.id} failure =>`,
          err,
        );
      });
  }

  // The CRM only knows contacts by phone, so a LID without a known phone is dropped,
  // as the Baileys instance does.
  private async resolveContactNumber(
    event: WaIncomingMessageEvent,
  ): Promise<ResolvedContact | null> {
    const resolved = resolveZapoContactNumber(event.key);
    if (!resolved) return null;

    if (resolved.contactNumber && resolved.source) {
      return { contactNumber: resolved.contactNumber, source: resolved.source };
    }

    if (!resolved.lidJid) return null;

    try {
      const stored = await this.getStore()
        .session(this.sessionId)
        .contacts.getByJid(resolved.lidJid);
      const phone =
        getPhoneFromZapoJid(stored?.phoneNumber) ||
        (stored?.phoneNumber && /^\d+$/.test(stored.phoneNumber)
          ? stored.phoneNumber
          : null);

      return phone ? { contactNumber: phone, source: "contact-store" } : null;
    } catch {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Failed to resolve LID mapping for incoming message ${event.key.id}.`,
      );
      return null;
    }
  }

  private async processIncomingMessage(
    event: WaIncomingMessageEvent,
    content: ZapoParsedContent,
    { contactNumber, source }: ResolvedContact,
  ) {
    const log = new Log<any>(
      this.client as any,
      this.clientName,
      "receive-message",
      event.key.id,
      { contactNumberSource: source },
    );

    try {
      if (!validatePhoneStr(contactNumber)) return;
      if (this.blockedNumbers.includes(contactNumber)) {
        return;
      }

      // Offline catch-up can redeliver a stanza that already reached the CRM.
      const [existingRows] = await whatsappClientPool.query<RowDataPacket[]>(
        "SELECT SYNC_MESSAGE FROM messages WHERE ID = ?",
        [event.key.id],
      );
      if (existingRows[0]?.["SYNC_MESSAGE"]) return;

      const parsedMessage = await this.parseIncomingMessage(event, content);
      log.setData((data: any) => ({ ...data, parsedMessage }));

      await this.saveMessage(parsedMessage, contactNumber);

      await axios
        .post(
          `${this.requestURL}/receive_message/${this.whatsappNumber}/${contactNumber}`,
          parsedMessage,
        )
        .catch((err: any) => {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Receive callback failed for message ${parsedMessage.ID}: ${err?.response?.status || err?.code || err?.message || "unknown error"}.`,
          );
        });

      const savedMessage = await this.pool
        .query("SELECT * FROM w_mensagens WHERE ID = ?", [parsedMessage.ID])
        .then(([rows]: any) => rows[0]);

      log.setData((data: any) => ({ ...data, savedMessage }));

      if (savedMessage) {
        await this.updateMessage(parsedMessage.ID, {
          SYNC_MESSAGE: true,
          SYNC_STATUS: true,
        });
      }

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Message success => ${event.key.id}`,
      );
    } catch (err: any) {
      log.setError(err);
      log.save();

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Message failure =>`,
        err.response ? err.response.data : err,
      );
    }
  }

  private async parseIncomingMessage(
    event: WaIncomingMessageEvent,
    content: ZapoParsedContent,
  ): Promise<ParsedMessage> {
    const messageTimestamp = event.timestampSeconds
      ? Math.trunc(event.timestampSeconds * 1000)
      : Date.now();
    const TIMESTAMP =
      process.env["USE_LOCAL_DATE"] === "true" ? Date.now() : messageTimestamp;

    const parsedMessage: ParsedMessage = {
      ID: event.key.id,
      ...(content.quotedId ? { ID_REFERENCIA: content.quotedId } : {}),
      TIPO: content.type,
      MENSAGEM: content.body,
      TIMESTAMP,
      FROM_ME: false,
      DATA_HORA: new Date(TIMESTAMP),
      STATUS: "RECEIVED",
      ARQUIVO: null,
    };

    if (!content.media) return parsedMessage;

    if (content.isViewOnce) {
      parsedMessage.MENSAGEM = appendNotice(
        parsedMessage.MENSAGEM,
        "Mídia de visualização única - visualize no WhatsApp",
      );
      return parsedMessage;
    }

    const bytes = await this.downloadIncomingMedia(event);
    if (!bytes) {
      parsedMessage.MENSAGEM = appendNotice(
        parsedMessage.MENSAGEM,
        "Não foi possível baixar o arquivo - visualize no WhatsApp",
      );
      return parsedMessage;
    }

    parsedMessage.ARQUIVO = await this.storeMediaFile(
      Buffer.from(bytes),
      content.media,
    );
    return parsedMessage;
  }

  private async downloadIncomingMedia(
    event: WaIncomingMessageEvent,
  ): Promise<Uint8Array | null> {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!this.client) throw new Error("Client not connected");
        return await this.client.message.downloadBytes(event, {
          maxBytes: MAX_MEDIA_BYTES,
        });
      } catch (err) {
        logWithDate(
          `Media download attempt ${attempt}/${maxRetries} failed =>`,
          err,
        );
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    return null;
  }

  // Audio is kept as MP3 like the Baileys and WWEBJS instances, so the CRM player works unchanged.
  private async storeMediaFile(
    buffer: Buffer,
    media: ZapoMediaDescriptor,
  ): Promise<NonNullable<ParsedMessage["ARQUIVO"]>> {
    let mimeType = media.mimeType;
    let finalBuffer = buffer;
    const isAudio = mimeType.includes("audio");

    if (isAudio) {
      try {
        finalBuffer = await formatToOpusAudio(buffer);
        mimeType = "audio/mpeg";
      } catch (err) {
        logWithDate("Audio conversion failed, using original =>", err);
      }
    }

    const ext =
      mimeType === "audio/mpeg" ? "mp3" : extension(mimeType) || "dat";
    const originalFileName = media.fileName || `unnamed.${ext}`;
    const sanitizedFileName = originalFileName.replace(/[<>:"/\\|?*]/g, "_");
    const NOME_ARQUIVO = `${randomUUID()}_${sanitizedFileName}`;

    const mediaDir = join(filesPath, "media");
    await mkdir(mediaDir, { recursive: true });
    await writeFile(join(mediaDir, NOME_ARQUIVO), finalBuffer);

    logWithDate(
      `Media saved successfully => ${NOME_ARQUIVO} (${finalBuffer.length} bytes)`,
    );

    return {
      NOME_ARQUIVO,
      TIPO: mimeType,
      NOME_ORIGINAL: originalFileName,
      ARMAZENAMENTO: "outros",
    };
  }

  private onReceiveMessageStatus(event: WaIncomingReceiptEvent) {
    // Receipts from our own other devices refer to messages the operator read on the phone.
    if (event.fromSelfDevice) return;

    const status = mapZapoReceiptStatus(event.status);
    if (!status) return;

    for (const messageId of event.messageIds) {
      this.enqueueProcessing(
        () => this.sendMessageStatus(messageId, status),
        "status",
        messageId,
      );
    }
  }

  private async sendMessageStatus(messageId: string, status: LegacyReceiptStatus) {
    try {
      await axios.put(`${this.requestURL}/update_message/${messageId}`, {
        status,
      });
      await this.updateMessage(messageId, { STATUS: status, SYNC_STATUS: true });

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Status success => ${status} ${messageId}`,
      );
    } catch (err: any) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Status failure =>`,
        err.response
          ? err.response.status
          : err.request
            ? err.request._currentUrl
            : err,
      );
      await this.updateMessage(messageId, { STATUS: status, SYNC_STATUS: false });
    }
  }

  // Returns the phone JID as corrected by WhatsApp (e.g. Brazilian 9th digit).
  private async resolveDestination(client: WaClient, contact: string) {
    const [result] = await client.profile.getLidsByPhoneNumbers([
      contact.replace(/\D/g, ""),
    ]);

    if (!result?.exists || result.invalid) {
      throw new Error(`Number not on WhatsApp: ${contact}`);
    }

    return result.phoneJid;
  }

  private async getQuote(
    jid: string,
    quotedMessageId: string | undefined,
  ): Promise<ZapoQuote | null> {
    if (!quotedMessageId) return null;

    const stored = await this.getStore()
      .session(this.sessionId)
      .messages.getById(quotedMessageId)
      .catch(() => null);

    if (!stored) {
      return { id: quotedMessageId, remoteJid: jid, fromMe: false };
    }

    const participant = stored.senderJid || stored.participantJid;
    return {
      id: quotedMessageId,
      remoteJid: stored.threadJid,
      fromMe: stored.fromMe,
      ...(participant ? { participant: toUserJid(participant) } : {}),
      ...(stored.messageBytes
        ? { message: proto.Message.decode(stored.messageBytes) }
        : {}),
    };
  }

  private async sendContent(
    client: WaClient,
    jid: string,
    content: WaSendMessageContent,
    quotedMessageId: string | undefined,
  ): Promise<string> {
    const quote = await this.getQuote(jid, quotedMessageId);
    const result = await client.message.send(jid, content, quote ? { quote } : {});

    await this.persistOutgoing(client, result.id);
    return result.id;
  }

  // Zapo does not archive what this client sends; storing it lets the operator quote it later.
  private async persistOutgoing(client: WaClient, messageId: string) {
    const event = this.outgoingEvents.get(messageId);
    this.outgoingEvents.delete(messageId);
    if (!event) return;

    try {
      const meJid = client.getCredentials()?.meJid;
      await this.getStore()
        .session(this.sessionId)
        .messages.upsert({
          id: messageId,
          threadJid: event.to,
          fromMe: true,
          ...(meJid ? { senderJid: toUserJid(meJid) } : {}),
          timestampMs: Date.now(),
          messageBytes: proto.Message.encode(event.message).finish(),
        });
    } catch (err) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Failed to archive sent message ${messageId} =>`,
        err,
      );
    }
  }

  private buildSentMessage(
    ID: string,
    TIPO: string,
    MENSAGEM: string,
    quotedMessageId: string | undefined,
    ARQUIVO: ParsedMessage["ARQUIVO"],
  ): ParsedMessage {
    const TIMESTAMP = Date.now();

    return {
      ID,
      ...(quotedMessageId ? { ID_REFERENCIA: quotedMessageId } : {}),
      TIPO,
      MENSAGEM,
      TIMESTAMP,
      FROM_ME: true,
      DATA_HORA: new Date(TIMESTAMP),
      STATUS: "SENT",
      ARQUIVO,
    };
  }

  public async sendText(
    contact: string,
    text: string,
    quotedMessageId?: string,
  ): Promise<ParsedMessage> {
    const log = new Log<any>(
      this.client as any,
      this.clientName,
      "send-text",
      `${Date.now()}`,
      { contact, text, quotedMessageId },
    );

    try {
      const client = this.getReadyClient();
      const jid = await this.resolveDestination(client, contact);
      log.event("resolved contact's whatsapp id");

      const messageId = await this.sendContent(
        client,
        jid,
        { type: "text", text },
        quotedMessageId,
      );
      log.event("sent whatsapp message");
      this.session.messageSent();

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Send text success => ${messageId}`,
      );

      return this.buildSentMessage(messageId, "chat", text, quotedMessageId, null);
    } catch (err: any) {
      log.setError(err);
      log.save();
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Send text failure =>`,
        err,
      );
      throw err;
    }
  }

  public async sendFile(options: SendFileOptions): Promise<ParsedMessage> {
    const log = new Log<any>(
      this.client as any,
      this.clientName,
      "send-file",
      `${Date.now()}`,
      { options: { ...options, file: undefined } },
    );

    try {
      const client = this.getReadyClient();
      const { contact, fileName, caption, quotedMessageId, isAudio } = options;
      const buffer: Buffer = Buffer.isBuffer(options.file)
        ? options.file
        : Buffer.from(options.file);
      const mimeType = options.mimeType || "application/octet-stream";
      const jid = await this.resolveDestination(client, contact);
      const captionField = caption ? { caption } : {};

      let content: WaSendMessageContent;
      let TIPO: string;

      if (isAudio === "true" || mimeType.includes("audio")) {
        try {
          const voiceNote = await transcodeToVoiceNote(buffer);
          const seconds = getOggOpusDurationSeconds(voiceNote);
          content = {
            type: "audio",
            media: voiceNote,
            mimetype: VOICE_NOTE_MIMETYPE,
            ptt: true,
            ...(seconds ? { seconds } : {}),
          };
          TIPO = "ptt";
        } catch (err) {
          logWithDate("Voice note conversion failed, sending original audio =>", err);
          content = { type: "audio", media: buffer, mimetype: mimeType };
          TIPO = "audio";
        }
      } else if (mimeType.includes("image")) {
        content = { type: "image", media: buffer, mimetype: mimeType, ...captionField };
        TIPO = "image";
      } else if (mimeType.includes("video")) {
        content = { type: "video", media: buffer, mimetype: mimeType, ...captionField };
        TIPO = "video";
      } else {
        content = {
          type: "document",
          media: buffer,
          mimetype: mimeType,
          fileName,
          ...captionField,
        };
        TIPO = "document";
      }

      const messageId = await this.sendContent(client, jid, content, quotedMessageId);
      log.event("sent whatsapp message");
      this.session.messageSent();

      const ARQUIVO = await this.storeMediaFile(buffer, {
        fileName: fileName || null,
        mimeType,
      }).catch((err) => {
        logWithDate("Failed to store sent file locally =>", err);
        return null;
      });

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Send file success => ${messageId}`,
      );

      return this.buildSentMessage(
        messageId,
        TIPO,
        caption || "",
        quotedMessageId,
        ARQUIVO,
      );
    } catch (err: any) {
      log.setError(err);
      log.save();
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Send file failure =>`,
        err,
      );
      throw err;
    }
  }

  public async getProfilePicture(number: string): Promise<string | null> {
    try {
      const client = this.getReadyClient();
      const jid = number.includes("@")
        ? number
        : `${number.replace(/\D/g, "")}@s.whatsapp.net`;
      const result = await client.profile.getProfilePicture(jid, "image");
      logWithDate("Get PFP URL Success!");

      return result.url || null;
    } catch (err) {
      logWithDate("Get PFP URL err =>", err);
      return null;
    }
  }

  public async getContactVars(number: string) {
    try {
      const currentSaudation = () => {
        const hour = new Date().getHours();

        if (hour >= 5 && hour < 12) return "Bom dia";
        if (hour >= 12 && hour < 18) return "Boa tarde";
        return "Boa noite";
      };

      const vars = {
        saudação_tempo: currentSaudation(),
        cliente_razao: "",
        cliente_cnpj: "",
        contato_primeiro_nome: "",
        contato_nome_completo: "",
      };

      const SELECT_QUERY = `
        SELECT
          cli.RAZAO,
          cli.CPF_CNPJ,
          ct.NOME
        FROM w_clientes_numeros ct
        LEFT JOIN clientes cli ON cli.CODIGO = ct.CODIGO_CLIENTE
        WHERE ct.NUMERO = ?
      `;

      const [rows] = await this.pool.query(SELECT_QUERY, [number]);
      const findContact = (
        rows as Array<{ RAZAO: string; CNPJ: string; NOME: string }>
      )[0];

      if (findContact) {
        vars.cliente_razao = findContact.RAZAO;
        vars.cliente_cnpj = findContact.CNPJ;
        vars.contato_primeiro_nome = findContact.NOME.split(" ")[0] || "";
        vars.contato_nome_completo = findContact.NOME;
      }

      return vars;
    } catch (err) {
      logWithDate("Get Contact vars err =>", err);
      throw err;
    }
  }

  public async validateNumber(number: string): Promise<string | false> {
    try {
      if (!this.client) throw new Error("Client not connected");

      const [result] = await this.client.profile.getLidsByPhoneNumbers([
        number.replace(/\D/g, ""),
      ]);

      return result?.exists && !result.invalid
        ? getJidUser(result.phoneJid) || false
        : false;
    } catch (err) {
      logWithDate("Validate number error =>", err);
      return false;
    }
  }

  public async loadMessages(): Promise<never> {
    throw new Error("load-messages is not supported for ZAPO instances");
  }

  public async loadAvatars() {
    return await loadAvatars(this as any);
  }

  private async saveMessage(message: ParsedMessage, from: string) {
    message = encodeParsedMessage(message);

    const log = new Log<any>(
      this.client as any,
      this.clientName,
      "save-local-message",
      message.ID,
      { message },
    );

    try {
      const query = `
        INSERT INTO messages (
          ID,
          MENSAGEM,
          ID_REFERENCIA,
          TIPO,
          TIMESTAMP,
          FROM_ME,
          DATA_HORA,
          STATUS,
          ARQUIVO_TIPO,
          ARQUIVO_NOME_ORIGINAL,
          ARQUIVO_NOME,
          ARQUIVO_ARMAZENAMENTO,
          SYNC_MESSAGE,
          SYNC_STATUS,
          INSTANCE,
          \`FROM\`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          MENSAGEM = VALUES(MENSAGEM),
          TIPO = VALUES(TIPO),
          TIMESTAMP = VALUES(TIMESTAMP),
          FROM_ME = VALUES(FROM_ME),
          DATA_HORA = VALUES(DATA_HORA),
          STATUS = VALUES(STATUS),
          ARQUIVO_TIPO = VALUES(ARQUIVO_TIPO),
          ARQUIVO_NOME_ORIGINAL = VALUES(ARQUIVO_NOME_ORIGINAL),
          ARQUIVO_NOME = VALUES(ARQUIVO_NOME),
          ARQUIVO_ARMAZENAMENTO = VALUES(ARQUIVO_ARMAZENAMENTO),
          SYNC_MESSAGE = VALUES(SYNC_MESSAGE),
          SYNC_STATUS = VALUES(SYNC_STATUS);
      `;

      const params = [
        message.ID,
        message.MENSAGEM || "",
        message.ID_REFERENCIA || null,
        message.TIPO || null,
        message.TIMESTAMP || null,
        message.FROM_ME ? 1 : 0,
        message.DATA_HORA || new Date(message.TIMESTAMP),
        message.STATUS || null,
        message.ARQUIVO?.TIPO || null,
        message.ARQUIVO?.NOME_ORIGINAL || null,
        message.ARQUIVO?.NOME_ARQUIVO || null,
        message.ARQUIVO?.ARMAZENAMENTO || null,
        0, // SYNC_MESSAGE
        0, // SYNC_STATUS
        this.sessionId,
        from,
      ];

      await whatsappClientPool.query(query, params);

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Message saved successfully => ${message.ID}`,
      );
    } catch (err: any) {
      log.setError(err);
      log.save();
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Save message failure =>`,
        err,
      );
    }
  }

  private async syncMessagesWithServer() {
    try {
      const [rows]: [RowDataPacket[], FieldPacket[]] =
        await whatsappClientPool.query(
          `
          SELECT * FROM messages
          WHERE (SYNC_MESSAGE = 0 OR SYNC_STATUS = 0)
          AND INSTANCE = ?
        `,
          [this.sessionId],
        );

      for (const message of rows) {
        const { ID, SYNC_MESSAGE, SYNC_STATUS, STATUS } = message;
        const log = new Log<any>(
          this.client as any,
          this.clientName,
          "sync-message",
          ID,
          {},
        );

        try {
          if (!SYNC_MESSAGE) {
            const parsedMessage = mapToParsedMessage(message);
            log.setData(() => ({ parsedMessage }));

            await axios
              .post(
                `${this.requestURL}/receive_message/${this.whatsappNumber}/${message["FROM"]}`,
                parsedMessage,
              )
              .then(() =>
                this.updateMessage(ID, {
                  SYNC_MESSAGE: true,
                  SYNC_STATUS: true,
                }),
              );
          }

          if (SYNC_MESSAGE && !SYNC_STATUS) {
            log.setData(() => ({ status: STATUS }));
            await axios
              .put(`${this.requestURL}/update_message/${ID}`, {
                status: STATUS,
              })
              .then(() => this.updateMessage(ID, { SYNC_STATUS: true }));
          }

          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Sync message success: ${ID}`,
          );
        } catch (err: any) {
          log.setError(err);
          log.save();
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Sync message failure =>`,
            err?.message,
          );
        }
      }
    } catch (err: any) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Sync messages failure =>`,
        err?.message,
      );
    }
  }

  private async updateMessage(
    id: string,
    {
      SYNC_STATUS,
      SYNC_MESSAGE,
      STATUS,
    }: { SYNC_STATUS?: boolean; SYNC_MESSAGE?: boolean; STATUS?: string },
  ) {
    try {
      const query = `UPDATE messages SET STATUS = COALESCE(?, STATUS), SYNC_STATUS = COALESCE(?, SYNC_STATUS), SYNC_MESSAGE = COALESCE(?, SYNC_MESSAGE) WHERE ID = ?;`;

      const params = [
        STATUS || null,
        SYNC_STATUS !== undefined ? SYNC_STATUS : null,
        SYNC_MESSAGE !== undefined ? SYNC_MESSAGE : null,
        id,
      ];

      await whatsappClientPool.query(query, params);
    } catch (err) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Update message failure =>`,
        err,
      );
    }
  }
}

function appendNotice(body: string, notice: string): string {
  return body ? `${body}\n${notice}` : notice;
}

export default WhatsappZapoInstance;
