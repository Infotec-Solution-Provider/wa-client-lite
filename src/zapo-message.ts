import type { Proto } from "zapo-js";

export type ZapoContactNumberSource =
  | "remoteJid"
  | "remoteJidAlt"
  | "contact-store";

export interface ZapoContactKey {
  readonly remoteJid: string;
  readonly remoteJidAlt?: string;
}

export interface ZapoContactNumber {
  contactNumber: string | null;
  // Set when only the LID is known, so the caller can look up the phone.
  lidJid: string | null;
  source: Exclude<ZapoContactNumberSource, "contact-store"> | null;
}

export interface ZapoMediaDescriptor {
  fileName: string | null;
  mimeType: string;
}

export interface ZapoParsedContent {
  type: string;
  body: string;
  quotedId: string | null;
  media: ZapoMediaDescriptor | null;
  isViewOnce: boolean;
}

export type LegacyReceiptStatus = "RECEIVED" | "READ" | "PLAYED";

const TECHNICAL_MESSAGE_KEYS = new Set([
  "senderKeyDistributionMessage",
  "protocolMessage",
  "reactionMessage",
  "encReactionMessage",
  "secretEncryptedMessage",
  "encEventResponseMessage",
  "encCommentMessage",
  "pollUpdateMessage",
  "messageContextInfo",
]);

export function getJidUser(jid: string | null | undefined): string | null {
  const localPart = jid?.split("@")[0];
  return localPart?.split(":")[0] || null;
}

export function isZapoPhoneJid(jid: string | null | undefined): boolean {
  return Boolean(
    jid &&
      (jid.endsWith("@s.whatsapp.net") ||
        jid.endsWith("@c.us") ||
        jid.endsWith("@hosted")),
  );
}

export function isZapoLidJid(jid: string | null | undefined): boolean {
  return Boolean(jid && (jid.endsWith("@lid") || jid.endsWith("@hosted.lid")));
}

export function getPhoneFromZapoJid(
  jid: string | null | undefined,
): string | null {
  if (!isZapoPhoneJid(jid)) return null;
  const user = getJidUser(jid);
  return user && /^\d+$/.test(user) ? user : null;
}

// Same precedence as resolveBaileysContactIdentity: the phone from remoteJidAlt
// wins over remoteJid; a bare LID is returned for the caller's mapping lookup.
export function resolveZapoContactNumber(
  key: ZapoContactKey,
): ZapoContactNumber | null {
  const primaryJid = key.remoteJid;
  if (!primaryJid || !(isZapoPhoneJid(primaryJid) || isZapoLidJid(primaryJid))) {
    return null;
  }

  const candidates = [
    { jid: key.remoteJidAlt, source: "remoteJidAlt" as const },
    { jid: primaryJid, source: "remoteJid" as const },
  ];

  for (const candidate of candidates) {
    const contactNumber = getPhoneFromZapoJid(candidate.jid);
    if (contactNumber) {
      return { contactNumber, lidJid: null, source: candidate.source };
    }
  }

  return {
    contactNumber: null,
    lidJid: isZapoLidJid(primaryJid) ? stripDevice(primaryJid) : null,
    source: null,
  };
}

export function mapZapoReceiptStatus(
  status: string,
): LegacyReceiptStatus | null {
  if (status === "delivered") return "RECEIVED";
  if (status === "read") return "READ";
  if (status === "played") return "PLAYED";
  return null;
}

// Returns null for protocol-only stanzas (receipts of edits, reactions, key
// distribution) that the legacy backend never stored.
export function parseZapoMessage(
  message: Proto.IMessage,
): ZapoParsedContent | null {
  const { content, isViewOnce } = unwrapMessage(message);
  const parsed = parseContent(content);
  if (!parsed) return null;

  const quotedId = getContextInfo(content)?.stanzaId || null;
  return { ...parsed, quotedId, isViewOnce };
}

function stripDevice(jid: string): string {
  return jid.replace(/:(\d+)(?=@)/, "");
}

function unwrapMessage(message: Proto.IMessage): {
  content: Proto.IMessage;
  isViewOnce: boolean;
} {
  let current = message;
  let isViewOnce = false;

  for (let depth = 0; depth < 6; depth += 1) {
    const inner =
      current.ephemeralMessage?.message ||
      current.groupMentionedMessage?.message ||
      current.botInvokeMessage?.message ||
      current.deviceSentMessage?.message ||
      current.documentWithCaptionMessage?.message;
    const viewOnce =
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message;

    if (viewOnce) {
      isViewOnce = true;
      current = viewOnce;
    } else if (inner) {
      current = inner;
    } else {
      break;
    }
  }

  if (
    current.imageMessage?.viewOnce ||
    current.videoMessage?.viewOnce ||
    current.audioMessage?.viewOnce
  ) {
    isViewOnce = true;
  }

  return { content: current, isViewOnce };
}

function getContextInfo(message: Proto.IMessage): Proto.IContextInfo | null {
  return (
    message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo ||
    message.videoMessage?.contextInfo ||
    message.ptvMessage?.contextInfo ||
    message.audioMessage?.contextInfo ||
    message.documentMessage?.contextInfo ||
    message.stickerMessage?.contextInfo ||
    message.contactMessage?.contextInfo ||
    message.locationMessage?.contextInfo ||
    null
  );
}

function formatContact(
  displayName: string | null | undefined,
  vcard: string | null | undefined,
): string {
  const number = vcard?.match(/TEL[^:]*:([^\n\r]+)/)?.[1]?.trim();
  return `Contato: ${displayName || "Contato"}${number ? ` (${number})` : ""}`;
}

// TIPO values follow the ones whatsapp-web.js and the Baileys instance already
// send (chat, image, video, ptt, document, sticker, vcard, location).
function parseContent(
  message: Proto.IMessage,
): Omit<ZapoParsedContent, "quotedId" | "isViewOnce"> | null {
  const text = message.extendedTextMessage?.text || message.conversation;
  if (text) {
    return { type: "chat", body: text, media: null };
  }
  if (message.imageMessage) {
    return {
      type: "image",
      body: message.imageMessage.caption || "",
      media: { fileName: null, mimeType: message.imageMessage.mimetype || "image/jpeg" },
    };
  }
  const video = message.videoMessage || message.ptvMessage;
  if (video) {
    return {
      type: "video",
      body: video.caption || "",
      media: { fileName: null, mimeType: video.mimetype || "video/mp4" },
    };
  }
  if (message.audioMessage) {
    return {
      type: message.audioMessage.ptt === false ? "audio" : "ptt",
      body: "",
      media: {
        fileName: null,
        mimeType: message.audioMessage.mimetype || "audio/ogg; codecs=opus",
      },
    };
  }
  if (message.documentMessage) {
    return {
      type: "document",
      body: message.documentMessage.caption || "",
      media: {
        fileName: message.documentMessage.fileName || null,
        mimeType: message.documentMessage.mimetype || "application/octet-stream",
      },
    };
  }
  if (message.stickerMessage) {
    return {
      type: "sticker",
      body: "",
      media: { fileName: null, mimeType: message.stickerMessage.mimetype || "image/webp" },
    };
  }
  if (message.contactMessage) {
    return {
      type: "vcard",
      body: formatContact(message.contactMessage.displayName, message.contactMessage.vcard),
      media: null,
    };
  }
  if (message.contactsArrayMessage) {
    const contacts = message.contactsArrayMessage.contacts || [];
    return {
      type: "vcard",
      body: contacts
        .map((contact) => formatContact(contact.displayName, contact.vcard))
        .join("\n"),
      media: null,
    };
  }
  const location = message.locationMessage || message.liveLocationMessage;
  if (location) {
    return {
      type: "location",
      body: `Localização: https://maps.google.com/maps?q=${location.degreesLatitude},${location.degreesLongitude}`,
      media: null,
    };
  }
  const reply =
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.buttonsResponseMessage?.selectedButtonId ||
    message.listResponseMessage?.title ||
    message.listResponseMessage?.singleSelectReply?.selectedRowId ||
    message.templateButtonReplyMessage?.selectedDisplayText ||
    message.templateButtonReplyMessage?.selectedId ||
    message.interactiveResponseMessage?.body?.text;
  if (reply) {
    return { type: "chat", body: reply, media: null };
  }
  const poll =
    message.pollCreationMessage ||
    message.pollCreationMessageV2 ||
    message.pollCreationMessageV3;
  if (poll) {
    const options = (poll.options || [])
      .map((option) => `- ${option.optionName || "Opção"}`)
      .join("\n");
    return {
      type: "poll",
      body: `Enquete: ${poll.name || "Enquete"}${options ? `\n${options}` : ""}`,
      media: null,
    };
  }

  const rawType = Object.entries(message).find(
    ([key, value]) =>
      !TECHNICAL_MESSAGE_KEYS.has(key) && value !== null && value !== undefined,
  )?.[0];
  if (!rawType) return null;

  return {
    type: rawType,
    body: `Tipo de mensagem não suportado (${rawType}) - visualize no WhatsApp`,
    media: null,
  };
}
