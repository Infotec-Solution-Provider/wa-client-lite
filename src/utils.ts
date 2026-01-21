import WAWebJS from "whatsapp-web.js";
import { join } from "node:path";
import { access, readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { Router } from "express";
import { config } from "dotenv";
import { extension } from "mime-types";
import { ParsedMessage } from "./types";
import archiver from "archiver";
import { createWriteStream } from "node:fs";

config();

export const filesPath = process.env["FILES_DIRECTORY"]!;

export function isMessageFromNow(message: WAWebJS.Message) {
	const messageDate = new Date(Number(`${message.timestamp}000`));
	const currentDate = new Date();
	const TWO_MINUTES = 1000 * 60 * 2;
	const timeDifference = currentDate.getTime() - messageDate.getTime();

	return timeDifference <= TWO_MINUTES;
}

export async function parseMessage(message: WAWebJS.Message) {
	try {
		if (process.env["USE_LOCAL_DATE"]) {
			message.timestamp = Date.now();
		}

		const quotedMessage = await message.getQuotedMessage();
		const ID_REFERENCIA = quotedMessage && quotedMessage.id._serialized;
		const ID = message.id._serialized;
		const TIPO = message.type;
		const MENSAGEM = message.body;
		const TIMESTAMP = process.env["USE_LOCAL_DATE"]
			? Date.now()
			: Number(`${message.timestamp}000`);

		const FROM_ME = message.fromMe;

		const STATUS =
			["PENDING", "SENT", "RECEIVED", "READ", "PLAYED"][message.ack] ||
			"ERROR";

		const serializedMessage = {
			ID,
			ID_REFERENCIA,
			TIPO,
			MENSAGEM,
			TIMESTAMP,
			FROM_ME,
			DATA_HORA: new Date(TIMESTAMP),
			STATUS,
		};

		if (message.hasMedia) {
			const messageMedia = await message.downloadMedia();
			const isAudio: boolean = messageMedia.mimetype.includes("audio");
			let mediaBuffer = Buffer.from(messageMedia.data, "base64");

			if (isAudio) {
				mediaBuffer = await formatToOpusAudio(mediaBuffer) as Buffer<ArrayBuffer>;
			}

			const uuid = randomUUID();
			const ARQUIVO_TIPO = messageMedia.mimetype;
			const ext = isAudio ? "mp3" : extension(ARQUIVO_TIPO) || "dat";
			const ARQUIVO_NOME = messageMedia.filename
				? `${uuid}_${messageMedia.filename}`
				: `${uuid}_unamed.${ext}`;
			const ARQUIVO_NOME_ORIGINAL = messageMedia.filename || ARQUIVO_NOME;

			const savePath = join(filesPath, "/media", ARQUIVO_NOME);
			await writeFile(savePath, mediaBuffer);
			await access(savePath);

			const serializedFile = {
				NOME_ARQUIVO: ARQUIVO_NOME,
				TIPO: ARQUIVO_TIPO,
				NOME_ORIGINAL: ARQUIVO_NOME_ORIGINAL,
				ARMAZENAMENTO: "outros",
			};

			const parsedMessage = {
				...serializedMessage,
				ARQUIVO: serializedFile,
			};

			return parsedMessage;
		}

		return { ...serializedMessage, ARQUIVO: null };
	} catch (err: any) {
		logWithDate("Parse Message Failure =>", err);

		return null;
	}
}

export function encodeParsedMessage(message: ParsedMessage): ParsedMessage {
	return {
		...message,
		MENSAGEM: encodeURI(message.MENSAGEM),
		ARQUIVO: message.ARQUIVO
			? {
				...message.ARQUIVO,
				NOME_ARQUIVO: encodeURI(message.ARQUIVO.NOME_ARQUIVO),
				NOME_ORIGINAL: encodeURI(message.ARQUIVO.NOME_ORIGINAL),
			}
			: null,
	};
}

export function decodeParsedMessage(message: ParsedMessage): ParsedMessage {
	return {
		...message,
		MENSAGEM: decodeURI(message.MENSAGEM),
		ARQUIVO: message.ARQUIVO
			? {
				...message.ARQUIVO,
				NOME_ARQUIVO: decodeURI(message.ARQUIVO.NOME_ARQUIVO),
				NOME_ORIGINAL: decodeURI(message.ARQUIVO.NOME_ORIGINAL),
			}
			: null,
	};
}

export function mapToParsedMessage(dbRow: any): ParsedMessage {
	return {
		ID: dbRow.ID,
		MENSAGEM: dbRow.MENSAGEM || "",
		ID_REFERENCIA: dbRow.ID_REFERENCIA || null,
		TIPO: dbRow.TIPO || null,
		TIMESTAMP: dbRow.TIMESTAMP || null,
		FROM_ME: dbRow.FROM_ME === 1,
		DATA_HORA: new Date(dbRow.TIMESTAMP),
		STATUS: dbRow.STATUS || "RECEIVED",
		ARQUIVO: dbRow.ARQUIVO_TIPO
			? {
				TIPO: dbRow.ARQUIVO_TIPO,
				NOME_ORIGINAL: dbRow.ARQUIVO_NOME_ORIGINAL || null,
				NOME_ARQUIVO: dbRow.ARQUIVO_NOME || null,
				ARMAZENAMENTO: dbRow.ARQUIVO_ARMAZENAMENTO || null,
			}
			: null,
	};
}

export function logWithDate(str: string, error?: any) {
	const dateSring = new Date().toLocaleString();

	if (error) {
		console.error(`${dateSring}: ${str}`, error);
	} else {
		console.log(`${dateSring}: ${str}`);
	}
}

export function getAllEndpoints(router: Router, path: string) {
	const endpoints: Array<string> = [];

	if (router && router.stack) {
		router.stack.forEach((layer) => {
			if (layer.route) {
				const subPath = layer.route.path;
				const methods = Object.keys((layer.route as any).methods);

				methods.forEach((method) => {
					endpoints.push(
						`${method
							.toUpperCase()
							.padEnd(6, " ")} ${path}${subPath}`
					);
				});
			}
		});
	}

	return endpoints;
}

export async function formatToOpusAudio(file: Buffer): Promise<Buffer> {
	try {
		const tempPath = join(filesPath, "temp");

		try {
			await access(tempPath);
		} catch {
			await mkdir(tempPath);
		}

		const savePath = join(tempPath, `${randomUUID()}.mp3`);
		const readableStream = new Readable({
			read() {
				this.push(file);
				this.push(null);
			},
		});

		const ffmpeg = spawn("ffmpeg", [
			"-i",
			"pipe:0",
			"-c:a",
			"libmp3lame",
			"-b:a",
			"128k",
			savePath,
		]);

		readableStream.pipe(ffmpeg.stdin);

		return new Promise((resolve, reject) => {
			ffmpeg.on("close", async (code: number) => {
				if (code === 0) {
					const file = await readFile(savePath);
					resolve(file);
				} else {
					reject(
						`Erro ao converter para Opus, código de saída: ${code}`
					);
				}
			});

			ffmpeg.on("error", (err: any) => {
				reject(err);
			});
		});
	} catch (err) {
		throw err;
	}
}

export function decodeSafeURI(uri: string) {
	try {
		return decodeURI(uri);
	} catch {
		return uri;
	}
}

export function isUUID(str: string) {
	const uuidRegex =
		/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
	return uuidRegex.test(str);
}

export function validatePhoneStr(str: string) {
	const hasInvalidDigits = /\D/.test(str);
	const hasInvalidLength = str.length < 10;

	return !hasInvalidDigits && !hasInvalidLength;
}

/**
 * Compacta uma pasta em um arquivo ZIP.
 * @param sourceFolder Caminho da pasta a ser compactada.
 * @param outputZipPath Caminho do arquivo ZIP de saída.
 * @returns Promise que resolve com o caminho do ZIP criado.
 */
export async function zipFolder(sourceFolder: string, outputZipPath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const output = createWriteStream(outputZipPath);
		const archive = archiver('zip', { zlib: { level: 9 } });

		output.on('close', () => {
			resolve(outputZipPath);
		});

		output.on('error', (err) => reject(err));
		archive.on('error', (err) => reject(err));

		archive.pipe(output);
		archive.directory(sourceFolder, false);
		archive.finalize();
	});
}

export function formatPhone(n: string) {
	let formatedNumber: string = "";

	if (!n) return "";

	if (n.length === 13) {
		formatedNumber = `+${n.slice(0, 2)} (${n.slice(2, 4)}) ${n.slice(4, 5)} ${n.slice(5, 9)}-${n.slice(9, 13)}`;
	} else if (n.length === 12) {
		formatedNumber = `+${n.slice(0, 2)} (${n.slice(2, 4)}) ${n.slice(4, 8)}-${n.slice(8, 12)}`;
	} else if (n.length === 11) {
		formatedNumber = `(${n.slice(0, 2)}) ${n.slice(2, 5)}-${n.slice(5, 8)}-${n.slice(8, 11)}`;
	} else if (n.length === 10) {
		formatedNumber = `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6, 10)}`;
	} else {
		formatedNumber = n;
	};

	return formatedNumber;
};

/**
 * Creates a task queue with a specified concurrency limit.
 * 
 * @param concurrencyLimit - The maximum number of tasks to run concurrently.
 * @returns An object with methods to add tasks to the queue and wait for all tasks to complete.
 * 
 * @function
 * @name createTaskQueue
 * 
 * @example
 * const queue = createTaskQueue(2);
 * 
 * queue.addTask(async () => {
 *   // Task 1
 * });
 * 
 * queue.addTask(async () => {
 *   // Task 2
 * });
 * 
 * queue.addTask(async () => {
 *   // Task 3
 * });
 * 
 * await queue.waitForCompletion();
 * 
 * @typedef {Object} TaskQueue
 * @property {function(() => Promise<any>): void} addTask - Adds a task to the queue.
 * @property {function(): Promise<void>} waitForCompletion - Waits for all tasks in the queue to complete.
 */
export function createTaskQueue(concurrencyLimit: number) {
	const taskQueue: Array<() => Promise<any>> = [];
	const promises: Array<Promise<any>> = [];

	const runTask = async (task: () => Promise<any>) => {
		await task();
		if (taskQueue.length > 0) {
			const nextTask = taskQueue.shift()!;
			await runTask(nextTask);
		}
	};

	const addTask = (task: () => Promise<any>) => {
		if (promises.length < concurrencyLimit) {
			promises.push(runTask(task));
		} else {
			taskQueue.push(task);
		}
	};

	const waitForCompletion = () => Promise.all(promises);

	return { addTask, waitForCompletion };
}