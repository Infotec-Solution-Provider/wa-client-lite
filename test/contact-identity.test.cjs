const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createWhatsappContactIdentity,
  toBaileysJid,
  toWwebjsChatId,
} = require("../src/contact-identity.ts");
const {
  ensureContactIdentitySchema,
} = require("../src/contact-identity-migration.ts");

test("normalizes phone JIDs without losing legacy phone compatibility", () => {
  assert.deepEqual(
    createWhatsappContactIdentity("5511999999999:12@s.whatsapp.net"),
    {
      IDENTIFICADOR: "5511999999999",
      TIPO_IDENTIFICADOR: "PHONE",
      NUMERO: "5511999999999",
    },
  );
});

test("keeps non-phone identifiers addressable", () => {
  assert.deepEqual(createWhatsappContactIdentity("123456789@lid"), {
    IDENTIFICADOR: "123456789@lid",
    TIPO_IDENTIFICADOR: "LID",
    NUMERO: null,
  });
  assert.deepEqual(createWhatsappContactIdentity("alice@username"), {
    IDENTIFICADOR: "alice@username",
    TIPO_IDENTIFICADOR: "USERNAME",
    NUMERO: null,
  });
  assert.deepEqual(
    createWhatsappContactIdentity("123456789@lid", "5511999999999"),
    {
      IDENTIFICADOR: "123456789@lid",
      TIPO_IDENTIFICADOR: "LID",
      NUMERO: "5511999999999",
    },
  );
});

test("builds provider addresses only for legacy phone identifiers", () => {
  assert.equal(toBaileysJid("5511999999999"), "5511999999999@s.whatsapp.net");
  assert.equal(toBaileysJid("123456789@lid"), "123456789@lid");
  assert.equal(toWwebjsChatId("5511999999999"), "5511999999999@c.us");
  assert.equal(toWwebjsChatId("123456789@lid"), "123456789@lid");
});

test("migrates the ERP contact table without making the new identifier mandatory for old writers", async () => {
  const statements = [];
  const pool = {
    query: async (statement) => {
      statements.push(statement);
      if (statement.includes("SHOW TABLES")) return [[{}]];
      if (statement.includes("LIKE 'IDENTIFICADOR'")) return [[]];
      if (statement.includes("LIKE 'TIPO_IDENTIFICADOR'")) return [[]];
      if (statement.includes("LIKE 'NUMERO'")) return [[{ Null: "NO" }]];
      if (statement.includes("SHOW INDEX")) return [[]];
      if (statement.includes("duplicateGroups")) return [[{ duplicateGroups: 0 }]];
      return [[], []];
    },
  };

  await ensureContactIdentitySchema(pool);

  assert.ok(statements.some((sql) => sql.includes("ADD COLUMN IDENTIFICADOR")));
  assert.ok(statements.some((sql) => sql.includes("MODIFY COLUMN NUMERO VARCHAR(32) NULL")));
  assert.ok(statements.some((sql) => sql.includes("ADD UNIQUE INDEX")));
  assert.ok(!statements.some((sql) => sql.includes("IDENTIFICADOR VARCHAR(191) NOT NULL")));
});
