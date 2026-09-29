const assert = require("node:assert/strict");
const test = require("node:test");

const {
  mapZapoReceiptStatus,
  parseZapoMessage,
  resolveZapoContactNumber,
} = require("../src/zapo-message.ts");
const { getOggOpusDurationSeconds } = require("../src/voice-note.ts");

test("uses remoteJidAlt phone when the chat is addressed by LID", () => {
  assert.deepEqual(
    resolveZapoContactNumber({
      remoteJid: "123456789@lid",
      remoteJidAlt: "5511999999999@s.whatsapp.net",
    }),
    { contactNumber: "5511999999999", lidJid: null, source: "remoteJidAlt" },
  );
});

test("reads the phone from phone chats without the device suffix", () => {
  assert.deepEqual(
    resolveZapoContactNumber({ remoteJid: "5511999999999:3@s.whatsapp.net" }),
    { contactNumber: "5511999999999", lidJid: null, source: "remoteJid" },
  );
});

test("returns an unresolved LID for the contact store fallback", () => {
  assert.deepEqual(resolveZapoContactNumber({ remoteJid: "123456789:2@lid" }), {
    contactNumber: null,
    lidJid: "123456789@lid",
    source: null,
  });
});

test("does not treat groups or broadcasts as contacts", () => {
  assert.equal(resolveZapoContactNumber({ remoteJid: "12345-678@g.us" }), null);
  assert.equal(resolveZapoContactNumber({ remoteJid: "status@broadcast" }), null);
});

test("maps text with its quoted message id", () => {
  assert.deepEqual(
    parseZapoMessage({
      extendedTextMessage: {
        text: "Olá",
        contextInfo: { stanzaId: "QUOTED123" },
      },
    }),
    {
      type: "chat",
      body: "Olá",
      media: null,
      quotedId: "QUOTED123",
      isViewOnce: false,
    },
  );
});

test("maps voice notes and documents to the legacy media types", () => {
  assert.deepEqual(
    parseZapoMessage({ audioMessage: { ptt: true, mimetype: "audio/ogg; codecs=opus" } }),
    {
      type: "ptt",
      body: "",
      media: { fileName: null, mimeType: "audio/ogg; codecs=opus" },
      quotedId: null,
      isViewOnce: false,
    },
  );

  assert.deepEqual(
    parseZapoMessage({
      ephemeralMessage: {
        message: {
          documentMessage: {
            fileName: "boleto.pdf",
            mimetype: "application/pdf",
            caption: "segue",
          },
        },
      },
    }),
    {
      type: "document",
      body: "segue",
      media: { fileName: "boleto.pdf", mimeType: "application/pdf" },
      quotedId: null,
      isViewOnce: false,
    },
  );
});

test("flags view-once media so it is not downloaded", () => {
  const parsed = parseZapoMessage({
    viewOnceMessageV2: { message: { imageMessage: { mimetype: "image/jpeg" } } },
  });

  assert.equal(parsed.type, "image");
  assert.equal(parsed.isViewOnce, true);
});

test("ignores protocol-only stanzas", () => {
  assert.equal(parseZapoMessage({ protocolMessage: { type: 0 } }), null);
  assert.equal(
    parseZapoMessage({ reactionMessage: { text: "👍" }, messageContextInfo: {} }),
    null,
  );
});

test("formats contacts and locations as readable text", () => {
  assert.deepEqual(
    parseZapoMessage({
      contactMessage: {
        displayName: "Maria",
        vcard: "BEGIN:VCARD\nTEL;type=CELL:+55 11 99999-9999\nEND:VCARD",
      },
    }).body,
    "Contato: Maria (+55 11 99999-9999)",
  );
  assert.equal(
    parseZapoMessage({ locationMessage: { degreesLatitude: -30, degreesLongitude: -51 } }).body,
    "Localização: https://maps.google.com/maps?q=-30,-51",
  );
});

test("maps receipts to legacy statuses and skips the rest", () => {
  assert.equal(mapZapoReceiptStatus("delivered"), "RECEIVED");
  assert.equal(mapZapoReceiptStatus("read"), "READ");
  assert.equal(mapZapoReceiptStatus("played"), "PLAYED");
  assert.equal(mapZapoReceiptStatus("inactive"), null);
});

function oggPage(granule, payload) {
  const header = Buffer.alloc(27);
  header.write("OggS", 0, "ascii");
  header.writeBigInt64LE(BigInt(granule), 6);
  return Buffer.concat([header, payload]);
}

test("reads the voice note duration from the last OGG page", () => {
  const opusHead = Buffer.alloc(19);
  opusHead.write("OpusHead", 0, "ascii");
  opusHead.writeUInt8(1, 8);
  opusHead.writeUInt8(1, 9);
  opusHead.writeUInt16LE(312, 10);

  const ogg = Buffer.concat([
    oggPage(0, opusHead),
    oggPage(48_000 * 2, Buffer.alloc(10)),
    oggPage(48_000 * 7 + 312, Buffer.alloc(10)),
  ]);

  assert.equal(getOggOpusDurationSeconds(ogg), 7);
  assert.equal(getOggOpusDurationSeconds(Buffer.from("not ogg")), null);
});
