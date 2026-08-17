export type WhatsappContactIdentifierType = "PHONE" | "LID" | "USERNAME";

export interface WhatsappContactIdentity {
  IDENTIFICADOR: string;
  TIPO_IDENTIFICADOR: WhatsappContactIdentifierType;
  NUMERO: string | null;
}

export function createWhatsappContactIdentity(
  identifier: string,
  phone: string | null = null,
): WhatsappContactIdentity {
  const normalizedIdentifier = stripDeviceFromJid(identifier.trim());
  const inferredPhone = getPhoneFromIdentifier(normalizedIdentifier);
  const normalizedPhone = phone || inferredPhone;

  if (inferredPhone) {
    return {
      IDENTIFICADOR: inferredPhone,
      TIPO_IDENTIFICADOR: "PHONE",
      NUMERO: inferredPhone,
    };
  }

  return {
    IDENTIFICADOR: normalizedIdentifier,
    TIPO_IDENTIFICADOR: isLidIdentifier(normalizedIdentifier)
      ? "LID"
      : "USERNAME",
    NUMERO: normalizedPhone,
  };
}

export function getPhoneFromIdentifier(identifier: string): string | null {
  const normalized = stripDeviceFromJid(identifier.trim());
  const phone = normalized
    .replace(/@(c\.us|s\.whatsapp\.net)$/, "")
    .replace(/^me:/, "");

  return /^\d+$/.test(phone) ? phone : null;
}

export function toBaileysJid(identifier: string): string {
  const normalized = identifier.trim().replace(/^me:/, "");
  return normalized.includes("@")
    ? normalized
    : `${normalized}@s.whatsapp.net`;
}

export function toWwebjsChatId(identifier: string): string {
  const normalized = identifier.trim().replace(/^me:/, "");
  return normalized.includes("@") ? normalized : `${normalized}@c.us`;
}

function stripDeviceFromJid(identifier: string): string {
  return identifier.replace(/:(\d+)(?=@)/, "");
}

function isLidIdentifier(identifier: string): boolean {
  return (
    identifier.endsWith("@lid") || identifier.endsWith("@hosted.lid")
  );
}
