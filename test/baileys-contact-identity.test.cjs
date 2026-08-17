const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveBaileysContactIdentity,
} = require("../src/baileys-contact-identity.ts");

test("uses remoteJidAlt phone when the primary JID is a LID", () => {
  const identity = resolveBaileysContactIdentity({
    remoteJid: "123456789@lid",
    remoteJidAlt: "5511999999999@s.whatsapp.net",
  });

  assert.deepEqual(identity, {
    contact: {
      IDENTIFICADOR: "123456789@lid",
      TIPO_IDENTIFICADOR: "LID",
      NUMERO: "5511999999999",
    },
    lidJid: null,
    primaryJid: "123456789@lid",
    source: "remoteJidAlt",
  });
});

test("keeps direct phone JIDs compatible", () => {
  const identity = resolveBaileysContactIdentity({
    remoteJid: "5511999999999:14@s.whatsapp.net",
  });

  assert.deepEqual(identity, {
    contact: {
      IDENTIFICADOR: "5511999999999",
      TIPO_IDENTIFICADOR: "PHONE",
      NUMERO: "5511999999999",
    },
    lidJid: null,
    primaryJid: "5511999999999:14@s.whatsapp.net",
    source: "remoteJid",
  });
});

test("returns an unresolved LID for the session mapping fallback", () => {
  const identity = resolveBaileysContactIdentity({
    remoteJid: "123456789@lid",
  });

  assert.deepEqual(identity, {
    contact: {
      IDENTIFICADOR: "123456789@lid",
      TIPO_IDENTIFICADOR: "LID",
      NUMERO: null,
    },
    lidJid: "123456789@lid",
    primaryJid: "123456789@lid",
    source: null,
  });
});

test("does not treat groups or status broadcasts as customer contacts", () => {
  assert.equal(
    resolveBaileysContactIdentity({ remoteJid: "12345@g.us" }),
    null,
  );
  assert.equal(
    resolveBaileysContactIdentity({ remoteJid: "status@broadcast" }),
    null,
  );
});
