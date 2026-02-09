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
  Browsers,
  jidNormalizedUser,
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
  private isLoadingContacts: boolean = false;

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

    logWithDate(
      `[${this.clientName} - ${this.whatsappNumber}] Using Baileys version: ${version.join(".")}`
    );

    // Use MySQL auth state
    let state: any;
    let saveCreds: () => Promise<void>;
    let removeCreds: () => Promise<void>;

    try {
      const authState = await useMySQLAuthState({
        session: `${this.clientName}_${this.whatsappNumber}`,
        host: process.env["BAILEYS_AUTH_DB_HOST"] || "localhost",
        port: Number(process.env["BAILEYS_AUTH_DB_PORT"]) || 3306,
        user: process.env["BAILEYS_AUTH_DB_USER"] || "root",
        password: process.env["BAILEYS_AUTH_DB_PASS"] || "",
        database: process.env["BAILEYS_AUTH_DB_NAME"] || "baileys_auth",
        tableName: process.env["BAILEYS_AUTH_TABLE_NAME"] || "auth",
      });
      state = authState.state;
      saveCreds = authState.saveCreds;
      removeCreds = authState.removeCreds;
    } catch (authError) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Failed to initialize MySQL auth state:`,
        authError
      );
      setTimeout(() => this.connectToWhatsApp(), 10000);
      return;
    }

    this.removeCreds = removeCreds;

    this.client = makeWASocket({
      auth: {
        creds: state.creds as any,
        keys: makeCacheableSignalKeyStore(state.keys as any, logger),
      },
      version,
      logger,
      browser: Browsers.windows("Chrome"),
      syncFullHistory: true,
      connectTimeoutMs: 60000,
      qrTimeout: 40000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
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
        const errorMessage = (lastDisconnect?.error as Boom)?.message || "";
        
        // Immediately mark as not ready to prevent sending messages
        this.isReady = false;
        this.isAuthenticated = false;

        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Connection closed (code: ${statusCode}) due to ${lastDisconnect?.error}`
        );

        // Handle specific disconnect reasons
        if (statusCode === DisconnectReason.loggedOut) {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Logged out. Clearing credentials and reconnecting...`
          );

          // Remove credentials from MySQL
          if (this.removeCreds) {
            await this.removeCreds();
          }

          // Reconnect after clearing credentials
          setTimeout(() => this.connectToWhatsApp(), 5000);
        } else if (statusCode === DisconnectReason.restartRequired || 
                   errorMessage.includes("QR refs") ||
                   errorMessage.includes("Stream Errored")) {
          // Restart required or QR expired - reconnect immediately without delay
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] Restart required or QR expired. Reconnecting immediately...`
          );
          this.reconnectAttempts = 0;
          setTimeout(() => this.connectToWhatsApp(), 2000);
        } else if (statusCode === DisconnectReason.connectionClosed ||
                   statusCode === DisconnectReason.connectionLost ||
                   statusCode === DisconnectReason.connectionReplaced ||
                   statusCode === DisconnectReason.timedOut) {
          // Connection issues - use exponential backoff
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
            logWithDate(
              `[${this.clientName} - ${this.whatsappNumber}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
            );
            setTimeout(() => this.connectToWhatsApp(), delay);
          } else {
            logWithDate(
              `[${this.clientName} - ${this.whatsappNumber}] Max reconnect attempts reached. Will retry in 5 minutes...`
            );
            this.reconnectAttempts = 0;
            setTimeout(() => this.connectToWhatsApp(), 300000);
          }
        } else {
          // Unknown error - try to reconnect anyway
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts), 60000);
            logWithDate(
              `[${this.clientName} - ${this.whatsappNumber}] Unknown disconnect reason. Reconnecting in ${delay}ms...`
            );
            setTimeout(() => this.connectToWhatsApp(), delay);
          }
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
      
      let saved = 0;
      let skipped = 0;
      
      for (const contact of contacts) {
        if (contact.id && !contact.id.includes("@g.us")) {
          const contactData: { id: string; name?: string; notify?: string } = {
            id: contact.id,
          };
          if (contact.name) contactData.name = contact.name;
          if (contact.notify) contactData.notify = contact.notify;
          this.phoneContacts.set(contact.id, contactData);
          
          // Salvar contato diretamente no banco de dados
          const result = await this.saveContactToDatabase(contactData).catch(() => false);
          if (result) saved++;
          else skipped++;
        }
      }
      
      if (saved > 0) {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Contacts saved to database: ${saved} saved, ${skipped} skipped`
        );
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

    // Handle messaging history set (sync historical messages and contacts)
    this.client.ev.on("messaging-history.set", async (historyData) => {
      const { messages, contacts, chats, isLatest, progress, syncType } = historyData;

      // Debug: Log completo do historyData
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] ========== HISTORY SYNC DEBUG ==========`
      );
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Raw historyData keys: ${Object.keys(historyData).join(", ")}`
      );
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] isLatest: ${isLatest}, progress: ${progress}%, syncType: ${syncType}`
      );
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Chats: ${chats?.length || 0}, Contacts: ${contacts?.length || 0}, Messages: ${messages?.length || 0}`
      );

      // Debug: Mostrar sample de contatos
      if (contacts && contacts.length > 0) {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Sample contacts (first 5):`
        );
        contacts.slice(0, 5).forEach((c, i) => {
          logWithDate(
            `  [${i}] id: ${c.id}, name: ${c.name || "N/A"}, notify: ${c.notify || "N/A"}, verifiedName: ${c.verifiedName || "N/A"}`
          );
        });
      } else {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] No contacts in this history sync`
        );
      }

      // Debug: Mostrar sample de chats
      if (chats && chats.length > 0) {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Sample chats (first 5):`
        );
        chats.slice(0, 5).forEach((c, i) => {
          logWithDate(
            `  [${i}] id: ${c.id}, name: ${c.name || "N/A"}, unreadCount: ${c.unreadCount || 0}`
          );
        });
      } else {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] No chats in this history sync`
        );
      }

      // Debug: Mostrar sample de mensagens
      if (messages && messages.length > 0) {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Sample messages (first 3):`
        );
        messages.slice(0, 3).forEach((m, i) => {
          logWithDate(
            `  [${i}] remoteJid: ${m.key?.remoteJid}, fromMe: ${m.key?.fromMe}, pushName: ${m.pushName || "N/A"}`
          );
        });
      } else {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] No messages in this history sync`
        );
      }

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] ========================================`
      );

      // Processar contatos do histórico (principal fonte de contatos!)
      if (contacts && contacts.length > 0) {
        this.processHistoryContacts(contacts).catch((err) => {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] History contacts processing error =>`,
            err
          );
        });
      }

      // Processar chats do histórico (extrair contatos dos chats)
      if (chats && chats.length > 0) {
        this.processHistoryChats(chats).catch((err) => {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] History chats processing error =>`,
            err
          );
        });
      }

      // Processar mensagens do histórico em background
      if (messages && messages.length > 0) {
        this.processHistoryMessages(messages).catch((err) => {
          logWithDate(
            `[${this.clientName} - ${this.whatsappNumber}] History messages processing error =>`,
            err
          );
        });
      }
    });
  }

  /**
   * Processa e salva contatos do histórico no banco de dados
   * Esta é a principal fonte de contatos quando o sync é executado
   */
  private async processHistoryContacts(contacts: Array<{ id: string; name?: string; notify?: string; verifiedName?: string }>) {
    let saved = 0;
    let skipped = 0;

    for (const contact of contacts) {
      try {
        // Ignorar grupos e status
        if (!contact.id || contact.id.includes("@g.us") || contact.id === "status@broadcast") {
          skipped++;
          continue;
        }

        // Criar objeto de contato
        const contactData: { id: string; name?: string; notify?: string } = {
          id: contact.id,
        };
        if (contact.name) contactData.name = contact.name;
        if (contact.notify) contactData.notify = contact.notify;
        if (contact.verifiedName) contactData.name = contactData.name || contact.verifiedName;

        // Adicionar à memória
        this.phoneContacts.set(contact.id, contactData);

        // Salvar no banco de dados
        const result = await this.saveContactToDatabase(contactData).catch(() => false);
        if (result) saved++;
        else skipped++;
      } catch {
        skipped++;
      }
    }

    if (saved > 0 || skipped > 0) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] History contacts processed: ${saved} saved, ${skipped} skipped (total in memory: ${this.phoneContacts.size})`
      );
    }
  }

  /**
   * Processa chats do histórico e extrai contatos
   */
  private async processHistoryChats(chats: Array<{ id?: string | null; name?: string | null }>) {
    let saved = 0;
    let skipped = 0;

    for (const chat of chats) {
      try {
        // Ignorar grupos e status
        if (!chat.id || chat.id.includes("@g.us") || chat.id === "status@broadcast") {
          skipped++;
          continue;
        }

        // Verificar se já existe na memória com nome
        const existing = this.phoneContacts.get(chat.id);
        if (existing?.name && !chat.name) {
          // Já temos um nome melhor, não substituir
          skipped++;
          continue;
        }

        // Criar objeto de contato a partir do chat
        const contactData: { id: string; name?: string; notify?: string } = {
          id: chat.id,
        };
        if (chat.name) contactData.name = chat.name;
        if (existing?.notify) contactData.notify = existing.notify;

        // Adicionar à memória
        this.phoneContacts.set(chat.id, contactData);

        // Salvar no banco de dados
        const result = await this.saveContactToDatabase(contactData).catch(() => false);
        if (result) saved++;
        else skipped++;
      } catch {
        skipped++;
      }
    }

    if (saved > 0 || skipped > 0) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] History chats processed: ${saved} contacts saved, ${skipped} skipped`
      );
    }
  }

  /**
   * Processa e salva mensagens do histórico no banco de dados
   */
  private async processHistoryMessages(messages: proto.IWebMessageInfo[]) {
    let saved = 0;
    let skipped = 0;
    let errors = 0;

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

    for (const waMessage of messages) {
      try {
        const remoteJid = waMessage.key.remoteJid;

        // Ignorar mensagens de status, broadcast e grupos
        if (!remoteJid || remoteJid === "status@broadcast" || remoteJid.endsWith("@broadcast")) {
          skipped++;
          continue;
        }

        if (remoteJid.includes("@g.us")) {
          skipped++;
          continue;
        }

        // Ignorar mensagens com @lid (Local ID)
        if (remoteJid.includes("@lid")) {
          skipped++;
          continue;
        }

        // Ignorar mensagens sem conteúdo
        if (!waMessage.message) {
          skipped++;
          continue;
        }

        // Ignorar mensagens de protocolo específicas
        const protocolMessage = waMessage.message.protocolMessage;
        const reactionMessage = waMessage.message.reactionMessage;
        const senderKeyDistributionMessage = waMessage.message.senderKeyDistributionMessage;

        if (protocolMessage || reactionMessage || senderKeyDistributionMessage) {
          skipped++;
          continue;
        }

        const contactNumber = remoteJid.replace(/@s\.whatsapp\.net/g, "");

        // Validar se é um número de telefone válido
        if (!validatePhoneStr(contactNumber)) {
          skipped++;
          continue;
        }

        // Verificar tipo da mensagem
        const messageType = this.getMessageType(waMessage.message);
        if (blockedTypes.includes(messageType)) {
          skipped++;
          continue;
        }

        // Parsear a mensagem (sem baixar mídia para histórico - economia de recursos)
        const parsedMessage = await this.parseHistoryMessage(waMessage);

        if (!parsedMessage) {
          skipped++;
          continue;
        }

        // Salvar mensagem no banco
        await this.saveHistoryMessage(parsedMessage, contactNumber);
        saved++;
      } catch (err) {
        errors++;
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] Error processing history message ${waMessage.key.id}:`,
          err
        );
      }
    }

    logWithDate(
      `[${this.clientName} - ${this.whatsappNumber}] History messages processed. Saved: ${saved}, Skipped: ${skipped}, Errors: ${errors}`
    );
  }

  /**
   * Parseia mensagem do histórico (versão simplificada sem download de mídia)
   */
  private async parseHistoryMessage(
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
      const TIMESTAMP = timestamp;
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

      // Para mensagens do histórico, não baixamos mídia para economizar recursos
      // Apenas registramos que existe um arquivo
      const contentType = getContentType(message);
      const mediaTypes = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"];
      const hasMedia = mediaTypes.includes(contentType || "");

      if (hasMedia) {
        const content = message[contentType as keyof proto.IMessage] as any;
        const mimeType = content?.mimetype || "application/octet-stream";
        const originalFileName = content?.fileName || `media.${contentType?.replace("Message", "")}`;

        serializedMessage.ARQUIVO = {
          NOME_ARQUIVO: null as any, // Não temos o arquivo baixado
          TIPO: mimeType,
          NOME_ORIGINAL: originalFileName,
          ARMAZENAMENTO: "pendente", // Marcamos como pendente para possível download futuro
        };
      }

      return serializedMessage;
    } catch (err) {
      logWithDate("Parse History Message Failure =>", err);
      return null;
    }
  }

  /**
   * Salva mensagem do histórico diretamente no banco do ERP (w_mensagens)
   * Isso evita que as mensagens do histórico abram novos atendimentos
   */
  private async saveHistoryMessage(message: ParsedMessage, from: string) {
    message = encodeParsedMessage(message);

    try {
      // 1. Buscar o CODIGO_NUMERO da tabela w_clientes_numeros
      const [numeroRows] = await this.pool.query<RowDataPacket[]>(
        "SELECT CODIGO FROM w_clientes_numeros WHERE NUMERO = ? LIMIT 1",
        [from]
      ).catch(() => [[] as RowDataPacket[]]);

      let codigoNumero: number | null = null;
      
      if (numeroRows[0]) {
        codigoNumero = numeroRows[0]["CODIGO"];
      } else {
        // Se o número não existe, criar o contato primeiro
        const contactData = { id: `${from}@s.whatsapp.net` };
        await this.saveContactToDatabase(contactData);
        
        // Buscar novamente
        const [newRows] = await this.pool.query<RowDataPacket[]>(
          "SELECT CODIGO FROM w_clientes_numeros WHERE NUMERO = ? LIMIT 1",
          [from]
        ).catch(() => [[] as RowDataPacket[]]);
        
        if (newRows[0]) {
          codigoNumero = newRows[0]["CODIGO"];
        }
      }

      // 2. Inserir na tabela w_mensagens do ERP
      const insertQuery = `
        INSERT IGNORE INTO w_mensagens (
          ID,
          CODIGO_NUMERO,
          CODIGO_ATENDIMENTO,
          CODIGO_OPERADOR,
          TIPO,
          MENSAGEM,
          FROM_ME,
          DATA_HORA,
          TIMESTAMP,
          ID_REFERENCIA,
          STATUS
        ) VALUES (?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?)
      `;

      const insertParams = [
        message.ID,
        codigoNumero,
        message.TIPO || "chat",
        message.MENSAGEM || "",
        message.FROM_ME ? 1 : 0,
        message.DATA_HORA || new Date(message.TIMESTAMP),
        message.TIMESTAMP || Date.now(),
        message.ID_REFERENCIA || null,
        message.STATUS || "RECEIVED",
      ];

      const [insertResult] = await this.pool.query<any>(insertQuery, insertParams);

      // 3. Se tiver arquivo, inserir na tabela w_mensagens_arquivos
      if (message.ARQUIVO && insertResult.insertId) {
        const arquivoQuery = `
          INSERT IGNORE INTO w_mensagens_arquivos (
            CODIGO_MENSAGEM,
            TIPO,
            NOME_ARQUIVO,
            NOME_ORIGINAL,
            ARMAZENAMENTO
          ) VALUES (?, ?, ?, ?, ?)
        `;

        await this.pool.query(arquivoQuery, [
          insertResult.insertId,
          message.ARQUIVO.TIPO || "application/octet-stream",
          message.ARQUIVO.NOME_ARQUIVO || null,
          message.ARQUIVO.NOME_ORIGINAL || null,
          message.ARQUIVO.ARMAZENAMENTO || "outros",
        ]).catch(() => null);
      }

      // 4. Salvar também no banco local (messages) para controle, já marcando como sincronizado
      const localQuery = `
        INSERT IGNORE INTO messages (
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
      `;

      const localParams = [
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
        1, // SYNC_MESSAGE - já sincronizado (salvo diretamente no ERP)
        1, // SYNC_STATUS - já sincronizado
        `${this.clientName}_${this.whatsappNumber}`,
        from,
      ];

      await whatsappClientPool.query(localQuery, localParams);
    } catch (err: any) {
      // Ignorar erro de duplicata (mensagem já existe)
      if (err?.code !== "ER_DUP_ENTRY") {
        throw err;
      }
    }
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
    let remoteJid = waMessage.key.remoteJid;
    logWithDate("Received message from remoteJid:", waMessage);
    if (remoteJid && remoteJid.includes("@lid")) {
        logWithDate(`[${this.clientName}] Recebido LID: ${remoteJid}. Tentando converter...`);
        
        const realJid = this.getJidFromLid(remoteJid);

        if (realJid) {
            logWithDate(`[${this.clientName}] SUCESSO: Convertido de ${remoteJid} para ${realJid}`);
            remoteJid = realJid; 
        } else {
            logWithDate(`[${this.clientName}] AVISO: Não encontrei o número vinculado ao LID ${remoteJid} na memória.`);
        }
    }
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

    // Se for um @lid (Local ID), ignorar pois não é um número real
    if (remoteJid.includes("@lid")) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Ignoring message from @lid (Local ID): ${remoteJid}`
      );
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

  /**
   * Salva um contato individual no banco de dados
   * @param contact Dados do contato com id, name e notify
   * @returns true se salvou com sucesso, false caso contrário
   */
  private async saveContactToDatabase(contact: { id: string; name?: string; notify?: string }): Promise<boolean> {
    try {
      // Validar se é um contato válido (não grupo, não status, não broadcast, não lid)
      if (!contact.id) {
        return false;
      }

      // Ignorar grupos (@g.us), status, broadcast e LID
      if (
        contact.id.includes("@g.us") ||
        contact.id.includes("@broadcast") ||
        contact.id.includes("@lid") ||
        contact.id === "status@broadcast" ||
        contact.id === "0@s.whatsapp.net"
      ) {
        return false;
      }

      // Extrair número do JID (formato: 5511999999999@s.whatsapp.net)
      const number = contact.id.replace(/@s\.whatsapp\.net/g, "");
      
      // Validar se é um número válido (apenas dígitos e tamanho mínimo)
      if (!number || number.length < 10 || !/^\d+$/.test(number)) {
        return false;
      }

      // Nome do contato (prioridade: name > notify > null)
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
        SELECT CODIGO_CLIENTE, NOME FROM contatos
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
          customerCode = contactRows[0]["CODIGO_CLIENTE"] || -1;
          dbContactName = contactRows[0]["NOME"] || null;
        }
      }

      // Nome final: prioridade banco de dados > contato do celular > número
      const finalName = dbContactName || contactName || number;

      // Inserir ou atualizar na tabela w_clientes_numeros
      // Só atualiza o nome se vier do banco (dbContactName)
      await this.pool.query(
        `INSERT INTO w_clientes_numeros (CODIGO_CLIENTE, NOME, NUMERO) 
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE 
           CODIGO_CLIENTE = IF(VALUES(CODIGO_CLIENTE) != -1, VALUES(CODIGO_CLIENTE), CODIGO_CLIENTE),
           NOME = IF(? IS NOT NULL, ?, NOME)`,
        [customerCode, finalName, number, dbContactName, dbContactName]
      );

      return true;
    } catch (err) {
      return false;
    }
  }

  public async loadContacts(): Promise<{ alreadyRunning: boolean; total?: number; saved?: number; skipped?: number; errors?: number }> {
    // Verificar se já está em execução
    if (this.isLoadingContacts) {
      return { alreadyRunning: true };
    }

    this.isLoadingContacts = true;

    try {
      if (!this.client) throw new Error("Client not connected");

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Starting contacts load... (${this.phoneContacts.size} contacts in memory)`
      );

      // Se não há contatos em memória, informar que os contatos serão carregados automaticamente
      if (this.phoneContacts.size === 0) {
        logWithDate(
          `[${this.clientName} - ${this.whatsappNumber}] No contacts in memory. Contacts will be saved automatically when the phone syncs via contacts.upsert event.`
        );
        return { alreadyRunning: false, total: 0, saved: 0, skipped: 0, errors: 0 };
      }

      const contacts = Array.from(this.phoneContacts.values());
      let saved = 0;
      let skipped = 0;
      let errors = 0;

      for (const contact of contacts) {
        try {
          const result = await this.saveContactToDatabase(contact);
          if (result) {
            saved++;
          } else {
            skipped++;
          }
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

      return { alreadyRunning: false, total: contacts.length, saved, skipped, errors };
    } catch (err) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Load contacts failure =>`,
        err
      );
      throw err;
    } finally {
      this.isLoadingContacts = false;
    }
  }

  /**
   * Obtém estatísticas dos contatos em memória e no banco de dados
   */
  public async getContactsStats(): Promise<{
    inMemory: number;
    inDatabase: number;
    contacts: Array<{ id: string; name?: string; notify?: string }>;
  }> {
    const contacts = Array.from(this.phoneContacts.values());
    
    // Contar contatos no banco de dados
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) as count FROM w_clientes_numeros"
    ).catch(() => [[{ count: 0 }] as RowDataPacket[]]);
    
    return {
      inMemory: contacts.length,
      inDatabase: rows[0]?.["count"] || 0,
      contacts: contacts.slice(0, 100) // Retornar apenas os primeiros 100 para visualização
    };
  }

  /**
   * Força a sincronização de contatos extraindo dos números das mensagens existentes no banco
   * Útil quando o history sync não trouxe contatos
   */
  public async syncContactsFromMessages(): Promise<{ total: number; saved: number; skipped: number; errors: number }> {
    if (!this.client) throw new Error("Client not connected");

    logWithDate(
      `[${this.clientName} - ${this.whatsappNumber}] Starting contacts sync from messages...`
    );

    let saved = 0;
    let skipped = 0;
    let errors = 0;

    try {
      // Buscar todos os números distintos das mensagens que ainda não estão em w_clientes_numeros
      const [rows] = await this.pool.query<RowDataPacket[]>(`
        SELECT DISTINCT m.NUMERO 
        FROM messages m
        LEFT JOIN w_clientes_numeros w ON m.NUMERO = w.NUMERO
        WHERE w.NUMERO IS NULL 
          AND m.NUMERO IS NOT NULL 
          AND m.NUMERO != ''
          AND LENGTH(m.NUMERO) >= 10
        LIMIT 1000
      `);

      const total = rows.length;

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Found ${total} numbers to sync from messages`
      );

      for (const row of rows) {
        try {
          const number = row["NUMERO"];
          const contactData: { id: string; name?: string; notify?: string } = {
            id: `${number}@s.whatsapp.net`,
          };

          // Verificar se já está em memória
          const existing = this.phoneContacts.get(contactData.id);
          if (existing?.name) {
            contactData.name = existing.name;
          }
          if (existing?.notify) {
            contactData.notify = existing.notify;
          }

          const result = await this.saveContactToDatabase(contactData);
          if (result) {
            saved++;
          } else {
            skipped++;
          }
        } catch {
          errors++;
        }
      }

      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Contacts sync from messages completed. Total: ${total}, Saved: ${saved}, Skipped: ${skipped}, Errors: ${errors}`
      );

      return { total, saved, skipped, errors };
    } catch (err) {
      logWithDate(
        `[${this.clientName} - ${this.whatsappNumber}] Sync contacts from messages failure =>`,
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
      if (!this.isReady || !this.isAuthenticated) {
        throw new Error("Connection not ready. Please wait for authentication.");
      }

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
      if (!this.isReady || !this.isAuthenticated) {
        throw new Error("Connection not ready. Please wait for authentication.");
      }

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
      if (!this.isReady || !this.isAuthenticated) {
        throw new Error("Connection not ready. Please wait for authentication.");
      }

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
  /**
 * Busca o JID real (Número) através do LID
 */
  private getJidFromLid(lid: string): string | null {
    console.log("Attempting to get JID from LID:", lid);
    const normalizedLid = jidNormalizedUser(lid);
    console.log("Searching for JID with LID:", normalizedLid);
    // Varre seus contatos em memória procurando quem tem esse LID
    for (const contact of this.phoneContacts.values()) {
      // Nota: Para isso funcionar, seu 'contacts.upsert' precisa estar salvando o campo 'lid'
      if ((contact as any).lid && jidNormalizedUser((contact as any).lid) === normalizedLid) {
        return contact.id; // Retorna o ID real (ex: 5583...@s.whatsapp.net)
      }
    }
    return null;
  }
}

export default WhatsappBaileysInstance;
