import {
  isHostedLidUser,
  isHostedPnUser,
  isJidGroup,
  isLidUser,
  isPnUser,
  jidDecode,
  type WAMessageKey,
} from "baileys";
import {
  createWhatsappContactIdentity,
  type WhatsappContactIdentity,
} from "./contact-identity";

export type BaileysContactIdentitySource =
  | "remoteJid"
  | "remoteJidAlt"
  | "lid-mapping";

export interface BaileysContactIdentity {
  contact: WhatsappContactIdentity;
  lidJid: string | null;
  primaryJid: string;
  source: Exclude<BaileysContactIdentitySource, "lid-mapping"> | null;
}

export function resolveBaileysContactIdentity(
  key: WAMessageKey | null | undefined,
): BaileysContactIdentity | null {
  const primaryJid = key?.remoteJid;

  if (!primaryJid || isNonContactJid(primaryJid)) {
    return null;
  }

  const alternateJid = key?.remoteJidAlt || null;
  const candidates: Array<{
    jid: string | null;
    source: Exclude<BaileysContactIdentitySource, "lid-mapping">;
  }> = [
    { jid: alternateJid, source: "remoteJidAlt" },
    { jid: primaryJid, source: "remoteJid" },
  ];

  for (const candidate of candidates) {
    const contactNumber = getPhoneNumberFromBaileysJid(candidate.jid);

    if (contactNumber) {
      return {
        contact: createWhatsappContactIdentity(
          isLidJid(primaryJid) ? primaryJid : contactNumber,
          contactNumber,
        ),
        lidJid: null,
        primaryJid,
        source: candidate.source,
      };
    }
  }

  const lidJid = candidates.find((candidate) =>
    isLidJid(candidate.jid),
  )?.jid;

  return {
    contact: createWhatsappContactIdentity(primaryJid),
    lidJid: lidJid || null,
    primaryJid,
    source: null,
  };
}

export function getPhoneNumberFromBaileysJid(
  jid: string | null | undefined,
): string | null {
  if (!jid || !(isPnUser(jid) || isHostedPnUser(jid))) {
    return null;
  }

  const number = jidDecode(jid)?.user;

  return number && /^\d+$/.test(number) ? number : null;
}

function isLidJid(jid: string | null): boolean {
  return Boolean(jid && (isLidUser(jid) || isHostedLidUser(jid)));
}

function isNonContactJid(jid: string): boolean {
  return (
    isJidGroup(jid) ||
    jid === "status@broadcast" ||
    jid.endsWith("@broadcast") ||
    jid.endsWith("@newsletter")
  );
}
