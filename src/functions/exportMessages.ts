import { ExportMessagesOptions, InpulseUser, SavedMessage, SavedMessageWithFile } from "../types";
import instances from "../instances";
import { FieldPacket, RowDataPacket } from "mysql2";
import ChatToExport from "../entities/ChatToExport";
import { tmpdir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { stringify } from "csv-stringify/sync";
import { createWriteStream } from "node:fs";
import { createTaskQueue, decodeSafeURI, zipFolder } from "../utils";
import { Pool } from "mysql2/promise";
import pdf from "html-pdf";

async function exportMessages({
    clientName,
    format,
    userId,
    startDate,
    endDate
}: ExportMessagesOptions) {
    const now = Date.now();
    const chatsDir = `${tmpdir()}/chats-${now}`;

    await mkdir(chatsDir, { recursive: true });

    const pool = instances.getPool(clientName);

    const messages: SavedMessage[] = await fetchMessages(userId, startDate, endDate, pool);
    const users: Map<number, InpulseUser> = await fetchUsers(pool);
    const chats: Map<number, ChatToExport> = mapChats(messages, users);

    if (format === "pdf" && messages.length > 5000) {
        throw new Error("Muitas mensagens para processar. \nPor favor, selecione outro formato de exportação ou um intervalo de datas menor.");
    }

    const taskQueue = createTaskQueue(format === "pdf" ? 2 : 100);

    switch (format) {
        case "txt":
            chats.forEach(chat => taskQueue.addTask(() => writeChatToTxt(clientName, chat, chatsDir)));
            break;
        case "pdf":
            chats.forEach(chat => taskQueue.addTask(() => writeChatToPdf(clientName, chat, chatsDir)));
            break;
        case "csv":
            chats.forEach(chat => taskQueue.addTask(() => writeChatToCsv(clientName, chat, chatsDir)));
            break;
        default:
            break;
    }

    await taskQueue.waitForCompletion();
    const outputPath = await zipFolder(chatsDir, chatsDir + ".zip");

    return outputPath;
}

async function fetchMessages(userId: string | number, startDate: string, endDate: string, pool: Pool) {
    if (userId === "*") {
        const [rows]: [RowDataPacket[], FieldPacket[]] = await pool.query(`
            SELECT 
                wm.*,
                wf.NOME_ARQUIVO AS ARQUIVO_NOME,
                wf.TIPO AS ARQUIVO_TIPO,
                wf.NOME_ORIGINAL AS ARQUIVO_NOME_ORIGINAL,
                wcn.NOME AS CONTATO_NOME,
                wcn.NUMERO AS CONTATO_NUMERO,
                wcn.CODIGO_CLIENTE AS CONTATO_CLIENTE
            FROM w_mensagens wm
            LEFT JOIN w_mensagens_arquivos wf ON wf.CODIGO_MENSAGEM = wm.CODIGO
            LEFT JOIN w_clientes_numeros wcn ON wcn.CODIGO = wm.CODIGO_NUMERO
            WHERE DATA_HORA BETWEEN ? AND ?
            ORDER BY DATA_HORA
        `, [startDate, endDate]);

        return rows as SavedMessage[];
    }
    const [rows]: [RowDataPacket[], FieldPacket[]] = await pool.query(`
            SELECT 
                wm.*,
                wf.NOME_ARQUIVO AS ARQUIVO_NOME,
                wf.TIPO AS ARQUIVO_TIPO,
                wf.NOME_ORIGINAL AS ARQUIVO_NOME_ORIGINAL,
                wcn.NOME AS CONTATO_NOME,
                wcn.NUMERO AS CONTATO_NUMERO,
                wcn.CODIGO_CLIENTE AS CONTATO_CLIENTE
            FROM w_mensagens wm
            LEFT JOIN w_mensagens_arquivos wf ON wf.CODIGO_MENSAGEM = wm.CODIGO
            LEFT JOIN w_clientes_numeros wcn ON wcn.CODIGO = wm.CODIGO_NUMERO
            WHERE CODIGO_OPERADOR = ? AND DATA_HORA BETWEEN ? AND ?
            ORDER BY DATA_HORA
        `, [userId, startDate, endDate]);

    return rows as SavedMessage[];
}

async function fetchUsers(pool: Pool) {
    const usersMap = new Map<number, InpulseUser>();
    const [rows]: [RowDataPacket[], FieldPacket[]] = await pool.query(`
            SELECT CODIGO, NOME FROM operadores
        `);

    rows.forEach((u) => usersMap.set(u.CODIGO, u as InpulseUser));

    return usersMap;
}

function mapChats(messages: SavedMessage[], users: Map<number, InpulseUser>) {
    const chats = new Map<number, ChatToExport>();

    messages.forEach(m => {
        m.MENSAGEM = decodeSafeURI(m.MENSAGEM);

        if ((m as SavedMessageWithFile).ARQUIVO_NOME_ORIGINAL) {
            (m as SavedMessageWithFile).ARQUIVO_NOME_ORIGINAL = decodeSafeURI((m as SavedMessageWithFile).ARQUIVO_NOME_ORIGINAL);
            (m as SavedMessageWithFile).ARQUIVO_NOME = decodeSafeURI((m as SavedMessageWithFile).ARQUIVO_NOME);
        }

        let chat = chats.get(m.CODIGO_NUMERO);

        if (!chat) {
            chat = new ChatToExport({
                id: m.CODIGO_NUMERO,
                name: m.CONTATO_NOME,
                phone: m.CONTATO_NUMERO,
                customerId: m.CONTATO_CLIENTE
            }, {
                id: m.CODIGO_OPERADOR,
                name: users.get(m.CODIGO_OPERADOR)?.NOME || "Desconhecido"
            });

            chats.set(m.CODIGO_NUMERO, chat);
        }

        chat.push(m);
    });

    chats.forEach(chat => {
        if (chat.getMessages().length > 500) {
            chat.getMessages().splice(0, chat.getMessages().length - 500);
        }
    })

    return chats;
}

export function toDownloadLink(message: SavedMessageWithFile, clientName: string): string {
    const baseUrl = (process.env.REQUEST_URL || "http://localhost:8000/api/:clientName").replace(":clientName", clientName);


    console.log(baseUrl)
    return `${baseUrl}/custom-routes/file/${message.ARQUIVO_NOME}`;
}

function writeChatToPdf(clientName: string, chat: ChatToExport, tempDir: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
        const html = chat.toHtml(clientName);

        pdf.create(html, { format: 'A4' }).toFile(`${tempDir}/${chat.getContact().phone}.pdf`, (err) => {
            if (err) {
                reject(err);
            }
            resolve();
        });

        setTimeout(() => reject("Timeout"), 10000);
    });
}

function writeChatToTxt(clientName: string, chat: ChatToExport, tempDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const filePath = `${tempDir}/${chat.getContact().phone}.txt`;
        const stream = createWriteStream(filePath);

        // generate header with contact name and phone
        stream.write(`[${chat.getContact().phone}] ${chat.getContact().name}\n\n`);

        chat.getMessages().forEach((m) => {
            const messageText = `[${m.DATA_HORA.toLocaleString()}] ${m.MENSAGEM}`;
            stream.write(`${messageText}\n`);

            if ((m as SavedMessageWithFile).ARQUIVO_NOME_ORIGINAL) {
                const cm = m as SavedMessageWithFile;
                let type: string;

                if (cm.ARQUIVO_TIPO.includes("image")) {
                    type = "Imagem";
                } else if (cm.ARQUIVO_TIPO.includes("audio")) {
                    type = "Áudio";
                } else if (cm.ARQUIVO_TIPO.includes("video")) {
                    type = "Vídeo";
                } else {
                    type = "Documento";
                }

                const link = `http://localhost:8000/api/${clientName}/custom-routes/file/${cm.ARQUIVO_NOME}`;
                stream.write(`(${type}) ${cm.ARQUIVO_NOME_ORIGINAL}: ${link}\n`);
            }

            stream.write('\n');
        });

        stream.end();

        stream.on('finish', resolve);
        stream.on('error', reject);
    });
}

function writeChatToCsv(clientName: string, chat: ChatToExport, tempDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const filePath = `${tempDir}/${chat.getContact().phone}.csv`;
        const records = [];

        records.push(["Data", "Enviado por", "Mensagem", "Arquivo", "Chat"]);

        chat.getMessages().forEach((m) => {
            let arquivo = (m as SavedMessageWithFile).ARQUIVO_NOME_ORIGINAL ? toDownloadLink((m as SavedMessageWithFile), clientName) : "";
            records.push([m.DATA_HORA.toLocaleString(), m.FROM_ME ? chat.getUser().name : chat.getContact().name, m.MENSAGEM, arquivo, chat.getContact().phone]);
        });

        const csv = stringify(records);
        writeFile(filePath, csv)
            .then(resolve)
            .catch(reject);
    });
}

export function getAttachmentType(fileType: string) {
    if (fileType.includes("image")) return "Imagem";
    if (fileType.includes("audio")) return "Áudio";
    if (fileType.includes("video")) return "Vídeo";

    return "Documento";
}

export default exportMessages;