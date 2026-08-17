import { Connection, FieldPacket, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { createWhatsappContactIdentity } from "../contact-identity";

async function getNumberErpId(connection: Connection, identifier: string, name?: string | null) {
    const identity = createWhatsappContactIdentity(identifier);
    const SELECT_CONTACT_QUERY = `SELECT * FROM w_clientes_numeros WHERE IDENTIFICADOR = ? OR (NUMERO IS NOT NULL AND NUMERO = ?) LIMIT 1`;
    const [rows]: [RowDataPacket[], FieldPacket[]] = await connection.execute(
        SELECT_CONTACT_QUERY,
        [identity.IDENTIFICADOR, identity.NUMERO],
    );

    if (!rows[0]) {
        const INSERT_CONTACT_QUERY = `INSERT INTO w_clientes_numeros (CODIGO_CLIENTE, NOME, NUMERO, IDENTIFICADOR, TIPO_IDENTIFICADOR) VALUES (?, ?, ?, ?, ?)`;

        const nameOrIdentifier = name?.slice(0, 30) || identity.IDENTIFICADOR;

        const [result]: [ResultSetHeader, FieldPacket[]] = await connection
            .execute(INSERT_CONTACT_QUERY, [
                -1,
                nameOrIdentifier,
                identity.NUMERO,
                identity.IDENTIFICADOR,
                identity.TIPO_IDENTIFICADOR,
            ]);

        return result.insertId;
    }

    const CODIGO_NUMERO = (rows[0] as { CODIGO: number }).CODIGO;

    return CODIGO_NUMERO;
}

export default getNumberErpId;
