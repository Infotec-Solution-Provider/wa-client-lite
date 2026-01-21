import { FieldPacket, ResultSetHeader } from "mysql2";
import { Pool, RowDataPacket } from "mysql2/promise";
import WAWebJS from "whatsapp-web.js";
import { ParsedMessage } from "../types";
import { logWithDate, parseMessage } from "../utils";
import WhatsappInstance from "../whatsapp";
import getNumberErpId from "./getNumberErpId";

async function loadMessages(instance: WhatsappInstance) {
    try {
        const chats = (await instance.client.getChats()).filter((c) => !c.isGroup);

        let successfulInserts = 0;
        let failedInserts = 0;
        let alreadyExists = 0;

        for (let i = 0; i < chats.length; i++) {
            const result = await processChat(instance.pool, instance, chats, i);

            if (result) {
                successfulInserts += result.successfulInserts;
                failedInserts += result.failedInserts;
                alreadyExists += result.alreadyExists;
            }
        }

        logWithDate(`Success: ${successfulInserts} | Failed: ${failedInserts} | Already Exists: ${alreadyExists}`);

        return ({ successfulInserts, failedInserts, alreadyExists });
    } catch (err: any) {
        logWithDate("Load Messages Error =>", err)

        throw err;
    }
}

async function processChat(pool: Pool, instance: WhatsappInstance, chats: WAWebJS.Chat[], index: number) {
    const chat = chats[index]!;
    const contact = await instance.client.getContactById(chat.id._serialized);
    logWithDate(`[${index + 1}/${chats.length}] Loading Contact Messages: ${chat.id.user}...`);

    if (contact) {
        return await processContactMessages(pool, chat, contact);
    }

    return null;
}

async function processContactMessages(pool: Pool, chat: WAWebJS.Chat, contact: WAWebJS.Contact) {
    try {
        const CODIGO_NUMERO = await getNumberErpId(pool, contact.id.user, contact.name);
        const blocked_types = ["e2e_notification", "notification_template", "call_log", "gp2"];
        const messages = (await chat.fetchMessages({ limit: Infinity })).filter(m => !blocked_types.includes(m.type));

        logWithDate(`Parsing ${messages.length} messages...`);

        return await parseAndSaveMessages(pool, messages, CODIGO_NUMERO);

    } catch (err) {
        logWithDate(`Failed to insert messages for ${contact.id.user} =>`, err);
        return null;
    }
}

async function parseAndSaveMessages(pool: Pool, messages: Array<WAWebJS.Message>, numberErpId: number) {
    let successfulInserts = 0;
    let failedInserts = 0;
    let alreadyExists = 0;

    for (const message of messages) {
        try {
            const messageExist = await verifyMessageExist(pool, message.id._serialized);

            if (messageExist) {
                alreadyExists++;
                continue;
            }

            console.log(`Parsing Message:`, message.type, message.id._serialized);
            const parsedMessage = await parseMessage(message);

            if (!parsedMessage) {
                failedInserts++;
                continue;
            }

            const insertedMessage = await saveMessage(pool, { ...parsedMessage, CODIGO_NUMERO: numberErpId });

            if (insertedMessage) {
                successfulInserts++;
            }
        } catch (err) {
            logWithDate(`Failed to parse message ${message.id._serialized} =>`, err);
            failedInserts++;
        }
    };

    return { successfulInserts, failedInserts, alreadyExists };
}

async function verifyMessageExist(pool: Pool, messageID: string) {
    const SELECT_MESSAGE_QUERY = "SELECT * FROM w_mensagens WHERE ID = ?";
    const [results]: [RowDataPacket[], FieldPacket[]] = await pool.query(SELECT_MESSAGE_QUERY, [messageID]);

    return results[0];
}

async function saveMessage(pool: Pool, message: ParsedMessage & { CODIGO_NUMERO: number }) {
    try {
        if (message) {
            const { CODIGO_NUMERO, TIPO, MENSAGEM, FROM_ME, DATA_HORA, TIMESTAMP, ID, ID_REFERENCIA, STATUS } = message;
            const INSERT_MESSAGE_QUERY = "INSERT INTO w_mensagens (CODIGO_OPERADOR, CODIGO_NUMERO, TIPO, MENSAGEM, FROM_ME, DATA_HORA, TIMESTAMP, ID, ID_REFERENCIA, STATUS) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

            console.log(`Inserting Message:`, message.TIPO, message.ID);

            const [results]: [ResultSetHeader, FieldPacket[]] = await pool.query(
                INSERT_MESSAGE_QUERY,
                [0, CODIGO_NUMERO, TIPO, encodeURI(MENSAGEM), FROM_ME, DATA_HORA, TIMESTAMP, ID, ID_REFERENCIA || null, STATUS]
            );

            const insertId = results.insertId;

            if (insertId && message.ARQUIVO) {
                console.log(`Inserting File:`, message.ARQUIVO.TIPO, message.ARQUIVO.NOME_ARQUIVO);
                const { NOME_ARQUIVO, TIPO, NOME_ORIGINAL, ARMAZENAMENTO } = message.ARQUIVO;
                const INSERT_FILE_QUERY = "INSERT INTO w_mensagens_arquivos (CODIGO_MENSAGEM, TIPO, NOME_ARQUIVO, NOME_ORIGINAL, ARMAZENAMENTO) VALUES (?, ?, ?, ?, ?)";
                await pool.query(INSERT_FILE_QUERY, [insertId, TIPO, encodeURI(NOME_ARQUIVO), encodeURI(NOME_ORIGINAL), ARMAZENAMENTO]);
            }

            return true;
        }
        return false;
    } catch (err) {
        logWithDate(`Failed to save message id ${message?.ID} =>`, err);

        return false;
    }
}

export default loadMessages;