import type { Pool, RowDataPacket } from "mysql2/promise";

interface ColumnRow extends RowDataPacket {
  Null: "YES" | "NO";
  Type: string;
}

export async function ensureMessageIdentitySchema(pool: Pool): Promise<void> {
  const [tables] = await pool.query<RowDataPacket[]>(
    "SHOW TABLES LIKE 'messages'",
  );
  if (!tables.length) {
    throw new Error("Table messages was not found.");
  }

  const [fromColumns] = await pool.query<ColumnRow[]>(
    "SHOW COLUMNS FROM messages LIKE 'FROM'",
  );
  const currentType = fromColumns[0]?.Type.toLowerCase() || "";
  const varcharLength = Number(currentType.match(/^varchar\((\d+)\)$/)?.[1]);
  if (!varcharLength || varcharLength < 191) {
    await pool.query(
      "ALTER TABLE messages MODIFY COLUMN `FROM` VARCHAR(191) NOT NULL",
    );
  }
}

interface DuplicateCountRow extends RowDataPacket {
  duplicateGroups: number;
}

export async function ensureContactIdentitySchema(pool: Pool): Promise<void> {
  const [tables] = await pool.query<RowDataPacket[]>(
    "SHOW TABLES LIKE 'w_clientes_numeros'",
  );
  if (!tables.length) {
    throw new Error("Table w_clientes_numeros was not found.");
  }

  const [identifierColumns] = await pool.query<ColumnRow[]>(
    "SHOW COLUMNS FROM w_clientes_numeros LIKE 'IDENTIFICADOR'",
  );
  if (!identifierColumns.length) {
    await executeSchemaChange(
      pool,
      "ALTER TABLE w_clientes_numeros ADD COLUMN IDENTIFICADOR VARCHAR(191) NULL AFTER NUMERO",
    );
  }

  const [typeColumns] = await pool.query<ColumnRow[]>(
    "SHOW COLUMNS FROM w_clientes_numeros LIKE 'TIPO_IDENTIFICADOR'",
  );
  if (!typeColumns.length) {
    await executeSchemaChange(
      pool,
      "ALTER TABLE w_clientes_numeros ADD COLUMN TIPO_IDENTIFICADOR VARCHAR(20) NOT NULL DEFAULT 'PHONE' AFTER IDENTIFICADOR",
    );
  }

  if (!identifierColumns.length || identifierColumns[0]?.Null !== "NO") {
    await pool.query(
      `UPDATE w_clientes_numeros
       SET IDENTIFICADOR = COALESCE(NULLIF(IDENTIFICADOR, ''), NULLIF(NUMERO, ''), CONCAT('legacy:', CODIGO))
       WHERE IDENTIFICADOR IS NULL OR IDENTIFICADOR = ''`,
    );
  }

  const [numberColumns] = await pool.query<ColumnRow[]>(
    "SHOW COLUMNS FROM w_clientes_numeros LIKE 'NUMERO'",
  );
  if (numberColumns[0]?.Null !== "YES") {
    await executeSchemaChange(
      pool,
      "ALTER TABLE w_clientes_numeros MODIFY COLUMN NUMERO VARCHAR(32) NULL",
    );
  }

  const [indexes] = await pool.query<RowDataPacket[]>(
    "SHOW INDEX FROM w_clientes_numeros WHERE Key_name = 'w_clientes_numeros_identificador_key'",
  );
  if (!indexes.length) {
    const [duplicates] = await pool.query<DuplicateCountRow[]>(
      `SELECT COUNT(*) AS duplicateGroups
       FROM (
         SELECT IDENTIFICADOR
         FROM w_clientes_numeros
         WHERE IDENTIFICADOR IS NOT NULL
         GROUP BY IDENTIFICADOR
         HAVING COUNT(*) > 1
       ) duplicate_identifiers`,
    );
    if (Number(duplicates[0]?.duplicateGroups || 0) > 0) {
      throw new Error(
        "Duplicate contact identifiers must be reconciled before migration.",
      );
    }

    await executeSchemaChange(
      pool,
      "ALTER TABLE w_clientes_numeros ADD UNIQUE INDEX w_clientes_numeros_identificador_key (IDENTIFICADOR)",
    );
  }
}

async function executeSchemaChange(pool: Pool, statement: string): Promise<void> {
  try {
    await pool.query(statement);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Duplicate column name|Duplicate key name/i.test(message)) {
      return;
    }
    throw error;
  }
}
