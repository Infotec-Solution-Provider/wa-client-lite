import axios from "axios";
import {
  ConnectionOptions,
  FieldPacket,
  Pool,
  RowDataPacket,
  createPool,
} from "mysql2/promise";
import makeWASocket, {
  DisconnectReason,
  WASocket,
  proto,
  downloadMediaMessage,
  getContentType,
  WAMessageKey,
  AnyMessageContent,
  MiscMessageGenerationOptions,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { useMySQLAuthState } from "mysql-baileys";
import { Boom } from "@hapi/boom";
import {
  encodeParsedMessage,
  formatToOpusAudio,
  logWithDate,
  mapToParsedMessage,
  validatePhoneStr,
} from "./utils";
import { DBAutomaticMessage, ParsedMessage, SendFileOptions } from "./types";
import loadMessages from "./functions/loadMessages";
import loadAvatars from "./functions/loadAvatars";
import { schedule } from "node-cron";
import runAutoMessage from "./build-automatic-messages";
import Log from "./log";
import whatsappClientPool from "./connection";
import { join } from "node:path";
import { writeFile, mkdir, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extension } from "mime-types";
import pino from "pino";

const filesPath = process.env["FILES_DIRECTORY"]!;

// Minimal logger to reduce noise
const logger = pino({ level: "silent" });

class WhatsappBaileysInstance {
  public readonly requestURL: string;
  public client: WASocket | null = null;
  public readonly clientName: string;
  public readonly whatsappNumber: string;
  public readonly pool: Pool;
  public isAuthenticated: boolean = false;
  public isReady: boolean = false;
  public connectionParams: ConnectionOptions;
  public blockedNumbers: Array<string> = [];
  public autoMessageCounters: Map<
    number,
    Array<{ number: string; count: number }>
  > = new Map();
  public awaitingMessages: {
    numbers: Array<string>;
    messages: Array<proto.IWebMessageInfo>;
  } = { numbers: [], messages: [] };
  private readonly autoMessages: Array<DBAutomaticMessage> = [];
  private contactQueues: Map<string, Array<() => Promise<void>>> = new Map();
  private contactProcessing: Map<string, boolean> = new Map();
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private removeCreds: (() => Promise<void>) | null = null;
  private phoneContacts: Map<string, { id: string; name?: string; notify?: string }> = new Map();

  constructor(
    clientName: string,
    whatsappNumber: string,
    requestURL: string,
    connection: ConnectionOptions
  ) {
    this.clientName = clientName;
    this.whatsappNumber = whatsappNumber;
    this.requestURL = requestURL;
    this.connectionParams = connection;

    schedule(process.env["CRON_LOAD_AVATARS"] || "0 */4 * * *", async () => {
      try {
        await this.loadAvatars();
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Avatars loaded successfully.`
        );
      } catch (err: any) {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Avatars loading failure =>`,
          err
        );
      }
    });

    schedule(process.env["CRON_SYNC_MESSAGES"] || "*/2 * * * *", () =>
      this.syncMessagesWithServer()
    );

    this.buildBlockedNumbers();
    this.buildAutomaticMessages();
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
          `[${this.clientName} - ${this.whatsappNumber}] Processing ${type} for ${contactNumber}...`
        );
        await task();
      }
    }

    this.contactProcessing.set(contactNumber, false);
  }

  private enqueueProcessing(
    task: () => Promise<void>,
    type: string,
    contactNumber: string
  ) {
    if (!this.contactQueues.has(contactNumber)) {
      this.contactQueues.set(contactNumber, []);
      this.contactProcessing.set(contactNumber, false);
    }

    this.contactQueues.get(contactNumber)!.push(task);
    this.processContactQueue(contactNumber, type);
  }

  public enqueueMessageProcessing(
    task: () => Promise<void>,
    contactNumber: string
  ) {
    this.enqueueProcessing(task, "message", contactNumber);
  }

  public enqueueStatusProcessing(
    task: () => Promise<void>,
    contactNumber: string
  ) {
    this.enqueueProcessing(task, "status", contactNumber);
  }

  private async buildBlockedNumbers() {
    const [rows]: [RowDataPacket[], FieldPacket[]] =
      await whatsappClientPool.query(
        `SELECT * FROM blocked_numbers WHERE instance_number = ?`,
        [this.whatsappNumber]
      );

    this.blockedNumbers = rows.map((r) => r["blocked_number"] as string);
  }

  private async buildAutomaticMessages() {
    const SELECT_BOTS_QUERY =
      "SELECT * FROM automatic_messages WHERE instance_number = ? AND is_active = 1";
    const [rows]: [RowDataPacket[], FieldPacket[]] =
      await whatsappClientPool.query(SELECT_BOTS_QUERY, [this.whatsappNumber]);
    const autoMessages = rows as DBAutomaticMessage[];

    this.autoMessages.push(...autoMessages);
  }

  public async initialize() {
    try {
      await axios.put(`${this.requestURL}/init/${this.whatsappNumber}`);
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Init success!`
      );
    } catch (err: any) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Init failure =>`,
        err.response
          ? err.response.status
          : err.request
            ? err.request._currentUrl
            : err
      );
    } finally {
      await this.connectToWhatsApp();
    }
  }

  private async connectToWhatsApp() {
    // Fetch latest Baileys version
    const { error, version } = await fetchLatestBaileysVersion();

    if (error) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] No connection to fetch version, retrying...`
      );
      setTimeout(() => this.connectToWhatsApp(), 5000);
      return;
    }

    // Use MySQL auth state
    const { state, saveCreds, removeCreds } = await useMySQLAuthState({
      session: `${this.clientName}_${this.whatsappNumber}`,
      host: process.env["BAILEYS_AUTH_DB_HOST"] || "localhost",
      port: Number(process.env["BAILEYS_AUTH_DB_PORT"]) || 3306,
      user: process.env["BAILEYS_AUTH_DB_USER"] || "root",
      password: process.env["BAILEYS_AUTH_DB_PASS"] || "",
      database: process.env["BAILEYS_AUTH_DB_NAME"] || "baileys_auth",
      tableName: process.env["BAILEYS_AUTH_TABLE_NAME"] || "auth",
    });

    this.removeCreds = removeCreds;

    this.client = makeWASocket({
      auth: {
        creds: state.creds as any,
        keys: makeCacheableSignalKeyStore(state.keys as any, logger),
      },
      version,
      printQRInTerminal: true,
      logger,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      defaultQueryTimeoutMs: undefined,
    });

    // Handle credentials update
    this.client.ev.on("creds.update", saveCreds);

    // Handle connection updates
    this.client.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          await axios.post(`${this.requestURL}/qr/${this.whatsappNumber}`, {
            qr,
          });
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] QR success => ${qr.slice(0, 30)}...`
          );
        } catch (err: any) {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] QR failure =>`,
            err?.response
              ? err.response.status
              : err.request
                ? err.request._currentUrl
                : err
          );
        }
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Connection closed due to ${lastDisconnect?.error}, reconnecting: ${shouldReconnect}`
        );

        if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
          setTimeout(() => this.connectToWhatsApp(), delay);
        } else if (statusCode === DisconnectReason.loggedOut) {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Logged out. Clearing credentials and reconnecting...`
          );
          this.isAuthenticated = false;
          this.isReady = false;

          // Remove credentials from MySQL
          if (this.removeCreds) {
            await this.removeCreds();
          }

          // Reconnect after clearing credentials
          setTimeout(() => this.connectToWhatsApp(), 5000);
        }
      } else if (connection === "open") {
        this.reconnectAttempts = 0;
        this.isAuthenticated = true;
        this.isReady = true;

        try {
          await axios.post(`${this.requestURL}/auth/${this.whatsappNumber}`, {});
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Auth success!`
          );
        } catch (err: any) {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Auth failure =>`,
            err?.response
              ? err.response.status
              : err.request
                ? err.request._currentUrl
                : err
          );
        }

        try {
          await axios.put(`${this.requestURL}/ready/${this.whatsappNumber}`);
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Ready success!`
          );
        } catch (err: any) {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Ready failure =>`,
            err?.response
              ? err.response.status
              : err.request
                ? err.request._currentUrl
                : err
          );
        }
      }
    });

    // Handle incoming messages
    this.client.ev.on("messages.upsert", async (m) => {
      if (m.type === "notify") {
        for (const message of m.messages) {
          await this.onReceiveMessage(message);
        }
      }
    });

    // Handle message status updates
    this.client.ev.on("messages.update", async (updates) => {
      for (const update of updates) {
        if (update.update.status) {
          await this.onReceiveMessageStatus(update.key, update.update.status);
        }
      }
    });

    // Handle contacts updates (Baileys recebe contatos do celular através deste evento)
    this.client.ev.on("contacts.upsert", async (contacts) => {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Received ${contacts.length} contacts from phone`
      );
      for (const contact of contacts) {
        if (contact.id && !contact.id.includes("@g.us")) {
          const contactData: { id: string; name?: string; notify?: string } = {
            id: contact.id,
          };
          if (contact.name) contactData.name = contact.name;
          if (contact.notify) contactData.notify = contact.notify;
          this.phoneContacts.set(contact.id, contactData);
        }
      }
    });

    // Handle contacts update (changes)
    this.client.ev.on("contacts.update", async (updates) => {
      for (const update of updates) {
        if (update.id && !update.id.includes("@g.us")) {
          const existing = this.phoneContacts.get(update.id);
          const contactData: { id: string; name?: string; notify?: string } = {
            id: update.id,
          };
          const finalName = update.name ?? existing?.name;
          const finalNotify = update.notify ?? existing?.notify;
          if (finalName) contactData.name = finalName;
          if (finalNotify) contactData.notify = finalNotify;
          this.phoneContacts.set(update.id, contactData);
        }
      }
    });
  }

  private isMessageFromNow(message: proto.IWebMessageInfo): boolean {
    const messageTimestamp = message.messageTimestamp as number;
    const messageDate = new Date(messageTimestamp * 1000);
    const currentDate = new Date();
    const TWO_MINUTES = 1000 * 60 * 2;
    const timeDifference = currentDate.getTime() - messageDate.getTime();

    return timeDifference <= TWO_MINUTES;
  }

  private getMessageType(message: proto.IMessage): string {
    const contentType = getContentType(message);

    if (!contentType) return "unknown";

    const typeMap: Record<string, string> = {
      conversation: "chat",
      extendedTextMessage: "chat",
      imageMessage: "image",
      videoMessage: "video",
      audioMessage: "ptt",
      documentMessage: "document",
      stickerMessage: "sticker",
      contactMessage: "vcard",
      contactsArrayMessage: "vcard",
      locationMessage: "location",
      liveLocationMessage: "location",
      reactionMessage: "reaction",
    };

    return typeMap[contentType] || contentType;
  }

  private getMessageBody(message: proto.IMessage): string {
    const contentType = getContentType(message);

    if (!contentType) return "";

    switch (contentType) {
      case "conversation":
        return message.conversation || "";
      case "extendedTextMessage":
        return message.extendedTextMessage?.text || "";
      case "imageMessage":
        return message.imageMessage?.caption || "";
      case "videoMessage":
        return message.videoMessage?.caption || "";
      case "documentMessage":
        return message.documentMessage?.caption || "";
      case "contactMessage":
        return message.contactMessage?.displayName || "";
      case "locationMessage":
        return `${message.locationMessage?.degreesLatitude},${message.locationMessage?.degreesLongitude}`;
      default:
        return "";
    }
  }

  private getQuotedMessageId(message: proto.IMessage): string | undefined {
    const contentType = getContentType(message);
    if (!contentType) return undefined;

    const content = message[contentType as keyof proto.IMessage] as any;
    return content?.contextInfo?.stanzaId;
  }

  private async parseMessage(
    waMessage: proto.IWebMessageInfo
  ): Promise<ParsedMessage | null> {
    try {
      const message = waMessage.message;
      if (!message) return null;

      const timestamp = (waMessage.messageTimestamp as number) * 1000;
      const ID = waMessage.key.id!;
      const ID_REFERENCIA = this.getQuotedMessageId(message);
      const TIPO = this.getMessageType(message);
      const MENSAGEM = this.getMessageBody(message);
      const TIMESTAMP = process.env["USE_LOCAL_DATE"] ? Date.now() : timestamp;
      const FROM_ME = waMessage.key.fromMe || false;

      const statusMap = ["PENDING", "SENT", "RECEIVED", "READ", "PLAYED"];
      const STATUS = statusMap[waMessage.status || 0] || "PENDING";

      const serializedMessage: ParsedMessage = {
        ID,
        ...(ID_REFERENCIA ? { ID_REFERENCIA } : {}),
        TIPO,
        MENSAGEM,
        TIMESTAMP,
        FROM_ME,
        DATA_HORA: new Date(TIMESTAMP),
        STATUS,
        ARQUIVO: null,
      };

      // Check if message has media
      const contentType = getContentType(message);
      const mediaTypes = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"];
      const hasMedia = mediaTypes.includes(contentType || "");

      if (hasMedia && this.client) {
        try {
          // Tentar download da mídia com retry
          let mediaBuffer: Buffer | null = null;
          let retryCount = 0;
          const maxRetries = 3;

          while (!mediaBuffer && retryCount < maxRetries) {
            try {
              mediaBuffer = await downloadMediaMessage(
                waMessage,
                "buffer",
                {},
                {
                  logger,
                  reuploadRequest: this.client.updateMediaMessage,
                }
              ) as Buffer;
            } catch (downloadErr) {
              retryCount++;
              logWithDate(`Media download attempt ${retryCount}/${maxRetries} failed =>`, downloadErr);
              if (retryCount < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
              }
            }
          }

          if (!mediaBuffer || mediaBuffer.length === 0) {
            logWithDate("Failed to download media after retries, skipping file save");
          } else {
            const content = message[contentType as keyof proto.IMessage] as any;
            let mimeType = content?.mimetype || "application/octet-stream";
            const isAudio = mimeType.includes("audio");

            let finalBuffer = mediaBuffer;
            if (isAudio) {
              try {
                finalBuffer = await formatToOpusAudio(mediaBuffer);
                mimeType = "audio/mpeg"; // Atualizar mimetype para mp3
              } catch (err) {
                logWithDate("Audio conversion failed, using original =>", err);
              }
            }

            const uuid = randomUUID();
            const ext = isAudio ? "mp3" : extension(mimeType) || "dat";
            const originalFileName = content?.fileName || `unnamed.${ext}`;
            // Sanitizar nome do arquivo
            const sanitizedFileName = originalFileName.replace(/[<>:"/\\|?*]/g, "_");
            const ARQUIVO_NOME = `${uuid}_${sanitizedFileName}`;

            // Ensure media directory exists before saving
            const mediaDir = join(filesPath, "media");
            try {
              await access(mediaDir);
            } catch {
              await mkdir(mediaDir, { recursive: true });
            }

            const savePath = join(filesPath, "media", ARQUIVO_NOME);
            await writeFile(savePath, finalBuffer);

            // Verificar se o arquivo foi salvo corretamente
            try {
              await access(savePath);
              logWithDate(`Media saved successfully => ${ARQUIVO_NOME} (${finalBuffer.length} bytes)`);

              serializedMessage.ARQUIVO = {
                NOME_ARQUIVO: ARQUIVO_NOME,
                TIPO: mimeType,
                NOME_ORIGINAL: originalFileName,
                ARMAZENAMENTO: "outros",
              };
            } catch (accessErr) {
              logWithDate("File was not saved correctly =>", accessErr);
            }
          }
        } catch (err) {
          logWithDate("Failed to process media =>", err);
        }
      }

      return serializedMessage;
    } catch (err) {
      logWithDate("Parse Message Failure =>", err);
      return null;
    }
  }

  public async onReceiveMessage(waMessage: proto.IWebMessageInfo) {
    const remoteJid = waMessage.key.remoteJid;

    // Ignorar mensagens de status e broadcast
    if (!remoteJid || remoteJid === "status@broadcast" || remoteJid.endsWith("@broadcast")) {
      return;
    }

    // Ignorar mensagens de grupo
    if (remoteJid.includes("@g.us")) {
      return;
    }

    // Ignorar mensagens próprias (enviadas pelo bot)
    if (waMessage.key.fromMe) {
      return;
    }

    // Ignorar mensagens de protocolo (sem conteúdo real)
    if (!waMessage.message) {
      return;
    }

    // Ignorar mensagens de protocolo específicas
    const protocolMessage = waMessage.message.protocolMessage;
    const reactionMessage = waMessage.message.reactionMessage;
    const senderKeyDistributionMessage = waMessage.message.senderKeyDistributionMessage;
    
    if (protocolMessage || reactionMessage || senderKeyDistributionMessage) {
      return;
    }

    const contactNumber = remoteJid.replace(/@s\.whatsapp\.net/g, "");

    this.enqueueMessageProcessing(async () => {
      const log = new Log<any>(
        this.client as any,
        this.clientName,
        "receive-message",
        `${waMessage.key.id}`,
        { message: waMessage }
      );

      try {
        // Tipos de mensagens bloqueadas (notificações, chamadas, etc.)
        const blockedTypes = [
          "e2e_notification",
          "notification_template",
          "call_log",
          "protocol",
          "reaction",
          "pollCreation",
          "pollUpdate",
          "ephemeral",
          "viewOnceMessage",
          "viewOnceMessageV2",
        ];
        const fromNow = this.isMessageFromNow(waMessage);
        const isPhone = validatePhoneStr(contactNumber);

        if (!isPhone) {
          return;
        }

        const message = waMessage.message;
        if (!message) return;

        const messageType = this.getMessageType(message);
        const isBlackListedType = blockedTypes.includes(messageType);
        const isBlackListedContact = this.blockedNumbers.includes(contactNumber);
        const isBlackListed = isBlackListedType || isBlackListedContact;

        // Run automatic messages
        for (const autoMessage of this.autoMessages) {
          await runAutoMessage(this as any, autoMessage, waMessage as any, contactNumber);
        }

        if (fromNow && !isBlackListed) {
          const parsedMessage = await this.parseMessage(waMessage);
          log.setData((data: any) => ({ ...data, parsedMessage }));

          if (!parsedMessage) {
            throw new Error("Parse message failure");
          }

          await this.saveMessage(parsedMessage, contactNumber);

          await axios
            .post(
              `${this.requestURL}/receive_message/${this.whatsappNumber}/${contactNumber}`,
              parsedMessage
            )
            .catch((err: any) => {
              console.log(
                err.response
                  ? {
                    status: err.response.status,
                    data: err.response.data,
                  }
                  : err.message
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
            `[${this.clientName} - ${this.whatsappNumber}] Message success => ${waMessage.key.id}`
          );
        }
      } catch (err: any) {
        log.setError(err);
        log.save();

        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Message failure =>`,
          err.response ? err.response.data : err
        );
      }
    }, contactNumber);
  }

  public async onReceiveMessageStatus(key: WAMessageKey, status: number) {
    const messageId = key.id;
    if (!messageId) return;

    this.enqueueStatusProcessing(async () => {
      try {
        const statusMap = ["ERROR", "PENDING", "SENT", "RECEIVED", "READ", "PLAYED"];
        const statusStr = statusMap[status] || "ERROR";

        await axios
          .put(`${this.requestURL}/update_message/${messageId}`, {
            status: statusStr,
          })
          .catch(() => null);

        await this.updateMessage(messageId, { SYNC_STATUS: true });

        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Status success => ${statusStr} ${messageId}`
        );
      } catch (err: any) {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Status failure =>`,
          err.response
            ? err.response.status
            : err.request
              ? err.request._currentUrl
              : err
        );
        await this.updateMessage(messageId, { SYNC_STATUS: false });
      }
    }, messageId);
  }

  public async loadMessages() {
    try {
      return await loadMessages(this as any);
    } catch (err) {
      throw err;
    }
  }

  public async loadAvatars() {
    try {
      return await loadAvatars(this as any);
    } catch (err) {
      throw err;
    }
  }

  public async loadGroups() {
    try {
      if (!this.client) throw new Error("Client not connected");

      const groups = await this.client.groupFetchAllParticipating();
      return Object.values(groups).map((group) => ({
        id: group.id,
        name: group.subject,
        isGroup: true,
      }));
    } catch (err) {
      throw err;
    }
  }

  public async loadContacts(): Promise<{ total: number; saved: number; skipped: number; errors: number }> {
    try {
      if (!this.client) throw new Error("Client not connected");

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Starting contacts load... (${this.phoneContacts.size} contacts in memory)`
      );

      const contacts = Array.from(this.phoneContacts.values());
      let saved = 0;
      let skipped = 0;
      let errors = 0;

      for (const contact of contacts) {
        try {
          // Extrair número do JID (formato: 5511999999999@s.whatsapp.net)
          const number = contact.id.replace(/@s\.whatsapp\.net/g, "");
          
          if (!number || number.length < 10) {
            skipped++;
            continue;
          }

          // Nome do contato (prioridade: name > notify > número)
          const contactName = contact.name || contact.notify || null;

          // Extrair DDD e corpo do número para buscar cliente
          const numberWithoutCountry = number.length > 11 ? number.slice(2) : number;
          const DDD = numberWithoutCountry.slice(0, 2);
          const numberBody = numberWithoutCountry.length === 10 
            ? numberWithoutCountry.slice(2) 
            : numberWithoutCountry.slice(3);

          const numberWithout9 = numberBody;
          const numberWith9 = numberBody.length === 8 ? `9${numberBody}` : numberBody;

          // Buscar cliente associado ao número
          const SEARCH_CUSTOMER_QUERY = `
            SELECT CODIGO FROM clientes
            WHERE (AREA1 = ? AND FONE1 = ?) OR 
                  (AREA2 = ? AND FONE2 = ?) OR 
                  (AREA3 = ? AND FONE3 = ?) OR 
                  (AREA1 = ? AND FONE1 = ?) OR 
                  (AREA2 = ? AND FONE2 = ?) OR 
                  (AREA3 = ? AND FONE3 = ?)
            LIMIT 1
          `;

          const SEARCH_CONTACT_QUERY = `
            SELECT CODIGO_CLIENTE as CODIGO, NOME FROM contatos
            WHERE (AREA_CEL = ? AND CELULAR = ?) OR 
                  (AREA_CEL = ? AND CELULAR = ?) OR
                  (AREA_DIRETO = ? AND FONE_DIRETO = ?) OR 
                  (AREA_DIRETO = ? AND FONE_DIRETO = ?) OR  
                  (AREA_RESI = ? AND FONE_RESIDENCIAL = ?) OR 
                  (AREA_RESI = ? AND FONE_RESIDENCIAL = ?)
            LIMIT 1
          `;

          const searchParams = [
            DDD, numberWith9,
            DDD, numberWith9,
            DDD, numberWith9,
            DDD, numberWithout9,
            DDD, numberWithout9,
            DDD, numberWithout9,
          ];

          let customerCode: number = -1;
          let dbContactName: string | null = null;

          // Buscar na tabela clientes
          const [customerRows] = await this.pool.query<RowDataPacket[]>(
            SEARCH_CUSTOMER_QUERY,
            searchParams
          ).catch(() => [[] as RowDataPacket[]]);

          if (customerRows[0]) {
            customerCode = customerRows[0]["CODIGO"];
          } else {
            // Buscar na tabela contatos
            const [contactRows] = await this.pool.query<RowDataPacket[]>(
              SEARCH_CONTACT_QUERY,
              searchParams
            ).catch(() => [[] as RowDataPacket[]]);

            if (contactRows[0]) {
              customerCode = contactRows[0]["CODIGO"] || -1;
              dbContactName = contactRows[0]["NOME"] || null;
            }
          }

          // Nome final: prioridade contato do celular > contato do banco > número
          const finalName = contactName || dbContactName || number;

          // Inserir ou atualizar na tabela w_clientes_numeros
          await this.pool.query(
            `INSERT INTO w_clientes_numeros (CODIGO_CLIENTE, NOME, NUMERO) 
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE 
               CODIGO_CLIENTE = IF(VALUES(CODIGO_CLIENTE) != -1, VALUES(CODIGO_CLIENTE), CODIGO_CLIENTE),
               NOME = IF(VALUES(NOME) IS NOT NULL AND VALUES(NOME) != NUMERO, VALUES(NOME), NOME)`,
            [customerCode, finalName, number]
          );

          saved++;
        } catch (err) {
          errors++;
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Error saving contact ${contact.id}:`,
            err
          );
        }
      }

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Contacts load completed. Total: ${contacts.length}, Saved: ${saved}, Skipped: ${skipped}, Errors: ${errors}`
      );

      return { total: contacts.length, saved, skipped, errors };
    } catch (err) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Load contacts failure =>`,
        err
      );
      throw err;
    }
  }

  public async sendText(
    contact: string,
    text: string,
    quotedMessageId?: string
  ): Promise<ParsedMessage | undefined> {
    const log = new Log<any>(
      this.client as any,
      this.clientName,
      "send-text",
      `${Date.now()}`,
      { contact, text, quotedMessageId }
    );

    try {
      if (!this.client) throw new Error("Client not connected");

      log.event("started sendText function");

      const jid = `${contact}@s.whatsapp.net`;
      const results = await this.client.onWhatsApp(jid);
      const result = results?.[0];

      if (!result?.exists) {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Number not on WhatsApp: ${contact}`
        );
        return undefined;
      }

      log.event("fetched contact's whatsapp id");

      const options: MiscMessageGenerationOptions = {};

      if (quotedMessageId) {
        options.quoted = {
          key: {
            remoteJid: jid,
            id: quotedMessageId,
          },
          message: {},
        } as proto.IWebMessageInfo;
      }

      const sentMessage = await this.client.sendMessage(jid, { text }, options);
      log.event("sent whatsapp message");
      log.setData((data: any) => ({ ...data, sentMessage }));

      if (sentMessage) {
        const parsedMessage = await this.parseMessage(sentMessage);
        log.event("parsed message");
        log.setData((data: any) => ({ ...data, parsedMessage }));

        if (parsedMessage) {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Send text success => ${parsedMessage.ID}`
          );
        }

        return parsedMessage || undefined;
      }

      return undefined;
    } catch (err: any) {
      log.setError(err);
      log.save();
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Send text failure =>`,
        err
      );
      return undefined;
    }
  }

  public async sendFile(options: SendFileOptions): Promise<ParsedMessage | undefined> {
    const log = new Log<any>(
      this.client as any,
      this.clientName,
      "send-file",
      `${Date.now()}`,
      { options }
    );

    try {
      if (!this.client) throw new Error("Client not connected");

      const {
        contact,
        file,
        mimeType,
        fileName,
        caption,
        quotedMessageId,
        isAudio,
      } = options;

      const jid = `${contact}@s.whatsapp.net`;
      let mediaBuffer: Buffer = file;

      if (isAudio === "true") {
        try {
          mediaBuffer = await formatToOpusAudio(file);
        } catch (err) {
          logWithDate("Audio conversion failed, using original =>", err);
        }
      }

      const msgOptions: MiscMessageGenerationOptions = {};

      if (quotedMessageId) {
        msgOptions.quoted = {
          key: {
            remoteJid: jid,
            id: quotedMessageId,
          },
          message: {},
        } as proto.IWebMessageInfo;
      }

      let content: AnyMessageContent;

      if (isAudio === "true" || mimeType.includes("audio")) {
        content = {
          audio: mediaBuffer,
          mimetype: "audio/mp4",
          ptt: true,
        };
      } else if (mimeType.includes("image")) {
        content = {
          image: mediaBuffer,
          ...(caption ? { caption } : {}),
          mimetype: mimeType,
        };
      } else if (mimeType.includes("video")) {
        content = {
          video: mediaBuffer,
          ...(caption ? { caption } : {}),
          mimetype: mimeType,
        };
      } else {
        content = {
          document: mediaBuffer,
          mimetype: mimeType,
          fileName: fileName,
          ...(caption ? { caption } : {}),
        };
      }

      const sentMessage = await this.client.sendMessage(jid, content, msgOptions);
      log.setData((data: any) => ({ ...data, sentMessage }));

      if (sentMessage) {
        const parsedMessage = await this.parseMessage(sentMessage);
        log.setData((data: any) => ({ ...data, parsedMessage }));

        if (parsedMessage) {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Send file success => ${parsedMessage.ID}`
          );
        }

        return parsedMessage || undefined;
      }

      return undefined;
    } catch (err: any) {
      log.setError(err);
      log.save();
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Send file failure =>`,
        err
      );
      return undefined;
    }
  }

  public async getProfilePicture(number: string): Promise<string | null> {
    try {
      if (!this.client) throw new Error("Client not connected");

      const jid = `${number}@s.whatsapp.net`;
      const pfpURL = await this.client.profilePictureUrl(jid, "image");
      logWithDate("Get PFP URL Success!");

      return pfpURL || null;
    } catch (err) {
      logWithDate("Get PFP URL err =>", err);
      return null;
    }
  }

  public async getContactVars(number: string) {
    try {
      const currentSaudation = () => {
        const currentTime = new Date();
        const hour = currentTime.getHours();

        if (hour >= 5 && hour < 12) {
          return "Bom dia";
        } else if (hour >= 12 && hour < 18) {
          return "Boa tarde";
        } else {
          return "Boa noite";
        }
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

      const jid = `${number}@s.whatsapp.net`;
      const results = await this.client.onWhatsApp(jid);
      const result = results?.[0];

      return result?.exists ? result.jid.replace(/@s\.whatsapp\.net/g, "") : false;
    } catch (err) {
      logWithDate("Validate number error =>", err);
      return false;
    }
  }

  private async saveMessage(message: ParsedMessage, from: string) {
    message = encodeParsedMessage(message);

    const log = new Log<any>(
      this.client as any,
      this.clientName,
      "save-local-message",
      message.ID,
      { message }
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
        `${this.clientName}_${this.whatsappNumber}`,
        from,
      ];

      try {
        await whatsappClientPool.query(query, params);
      } catch (err) {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] MySQL Pool Query error =>`,
          err
        );
        throw err;
      }

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Message saved successfully => ${message.ID}`
      );
    } catch (err: any) {
      log.setError(err);
      log.save();
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Save message failure =>`,
        err
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
          [`${this.clientName}_${this.whatsappNumber}`]
        );

      for (const message of rows) {
        const { ID, SYNC_MESSAGE, SYNC_STATUS, STATUS } = message;
        const log = new Log<any>(
          this.client as any,
          this.clientName,
          "sync-message",
          ID,
          {}
        );

        try {
          // Sync message with server
          if (!SYNC_MESSAGE) {
            const parsedMessage = mapToParsedMessage(message);
            log.setData(() => ({ parsedMessage }));

            await axios
              .post(
                `${this.requestURL}/receive_message/${this.whatsappNumber}/${message["FROM"]}`,
                parsedMessage
              )
              .then(() =>
                this.updateMessage(ID, {
                  SYNC_MESSAGE: true,
                  SYNC_STATUS: true,
                })
              );
          }

          // Sync message status with server
          if (SYNC_MESSAGE && !SYNC_STATUS) {
            log.setData(() => ({ status: STATUS }));
            await axios
              .put(`${this.requestURL}/update_message/${message["FROM"]}`, {
                status: STATUS,
              })
              .then(() => this.updateMessage(ID, { SYNC_STATUS: true }));
          }

          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Sync message success: ${ID}`
          );
        } catch (err: any) {
          log.setError(err);
          log.save();
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Sync message failure =>`,
            err?.message
          );
        }
      }
    } catch (err: any) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Sync messages failure =>`,
        err?.message
      );
    }
  }

  private async updateMessage(
    id: string,
    {
      SYNC_STATUS,
      SYNC_MESSAGE,
      STATUS,
    }: { SYNC_STATUS?: boolean; SYNC_MESSAGE?: boolean; STATUS?: string }
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

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Message updated successfully => ${id}`
      );
    } catch (err) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Update message failure =>`,
        err
      );
    }
  }

  // Method to gracefully close the connection
  public async close(clearCredentials: boolean = false) {
    if (this.client) {
      this.client.end(undefined);
      this.client = null;
      this.isReady = false;
      this.isAuthenticated = false;

      if (clearCredentials && this.removeCreds) {
        await this.removeCreds();
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Credentials cleared from MySQL`
        );
      }
    }
  }

  // Method to logout and clear credentials
  public async logout() {
    await this.close(true);
  }
}

export default WhatsappBaileysInstance;
