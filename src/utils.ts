import WAWebJS from "whatsapp-web.js";
import { join } from "node:path";
import { access, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { config } from "dotenv";
import { extension } from "mime-types";
import { ParsedMessage } from "./types";
import Ffmpeg from "fluent-ffmpeg";

config();

const filesPath = process.env.FILES_DIRECTORY!;

function isMessageFromNow(message: WAWebJS.Message) {
	const messageDate = new Date(Number(`${message.timestamp}000`));
	const currentDate = new Date();
	const TWO_MINUTES = 1000 * 60 * 2;
	const timeDifference = currentDate.getTime() - messageDate.getTime();

	return timeDifference <= TWO_MINUTES;
}

async function parseMessage(message: WAWebJS.Message) {
	try {
		if (process.env.USE_LOCAL_DATE) {
			message.timestamp = Date.now();
		}

		const quotedMessage = await message.getQuotedMessage();
		const ID_REFERENCIA = quotedMessage && quotedMessage.id._serialized;
		const ID = message.id._serialized;
		const TIPO = message.type;
		const MENSAGEM = message.body;
		const TIMESTAMP = process.env.USE_LOCAL_DATE
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
				mediaBuffer = await formatToOpusAudio(mediaBuffer);
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

function encodeParsedMessage(message: ParsedMessage): ParsedMessage {
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

function decodeParsedMessage(message: ParsedMessage): ParsedMessage {
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

function mapToParsedMessage(dbRow: any): ParsedMessage {
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

async function logWithDate(str: string, error?: any) {
	const dateSring = new Date().toLocaleString();

	if (error) {
		console.error(`${dateSring}: ${str}`, error);
	} else {
		console.log(`${dateSring}: ${str}`);
	}
}

function getAllEndpoints(router: Router, path: string) {
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

async function formatToOpusAudio(inputBuffer: Buffer): Promise<Buffer> {
  if (!inputBuffer?.length) throw new Error("Buffer de entrada vazio.");

  const TARGET_CONTAINER = "mp3";
  const TARGET_CODEC = "libmp3lame";
  const TARGET_BITRATE = "64k";  
  const TARGET_RATE = 44100;     
  const TARGET_CHANNELS = 1;

  const baseDir = join(filesPath, "temp_mp3");
  const inDir = join(baseDir, "in");
  const outDir = join(baseDir, "out");

  const ensureDir = async (p: string) => {
    try { await access(p); } catch { await mkdir(p, { recursive: true }); }
  };
  const writeTempFile = async (buf: Buffer, ext: string) => {
    await ensureDir(inDir);
    const p = join(inDir, `${randomUUID()}.${ext}`);
    await writeFile(p, new Uint8Array(buf)); 
    return p;
  };
  const safeUnlink = async (p?: string) => {
    if (!p) return;
    try { await rm(p, { force: true }); } catch {}
  };
  const ffprobeSafe = (p: string) =>
    new Promise<any>((resolve, reject) => {
      Ffmpeg.ffprobe(p, (err, data) => (err ? reject(err) : resolve(data)));
    });

  await ensureDir(inDir);
  await ensureDir(outDir);

  const tmpInPath = await writeTempFile(inputBuffer, "bin");
  const tmpOutPath = join(outDir, `${randomUUID()}.${TARGET_CONTAINER}`);

  let probeInfo: any = null;

  try {
    try {
      probeInfo = await ffprobeSafe(tmpInPath);
    } catch {
    }

    const stderrLines: string[] = [];

    await new Promise<void>((resolve, reject) => {
      Ffmpeg(tmpInPath)
        .noVideo()
        .audioChannels(TARGET_CHANNELS)
        .audioFrequency(TARGET_RATE)
        .audioCodec(TARGET_CODEC)
        .audioBitrate(TARGET_BITRATE)
        .format(TARGET_CONTAINER)
        .outputOptions([
          "-vn" ,
		  "-application",
		  "voip" 
        ])
        .on("stderr", (line) => stderrLines.push(line))
        .on("error", (err) => {
          const streams =
            probeInfo?.streams?.map(
              (s: any) => `${s.codec_type}/${s.codec_name}/${s.sample_rate || ""}`
            ) || [];
          err.message =
            `Falha na conversão (${err.message}).\n` +
            `Input: ${tmpInPath}\nOutput: ${tmpOutPath}\n` +
            `Probe streams: ${streams.join(", ") || "N/A"}\n` +
            `ffmpeg stderr:\n${stderrLines.join("\n")}`;
          reject(err);
        })
        .on("end", () => resolve())
        .save(tmpOutPath);
    });

    const outputBuffer = await readFile(tmpOutPath);

    if (process.env["KEEP_TEMP_AUDIO"] !== "true") {
      await safeUnlink(tmpInPath);
      await safeUnlink(tmpOutPath);
      try { await rm(baseDir, { recursive: true }); } catch {}
    }

    return outputBuffer;
  } catch (e) {
    await safeUnlink(tmpInPath);
    throw e;
  }
}

function decodeSafeURI(uri: string) {
	try {
		return decodeURI(uri);
	} catch {
		return uri;
	}
}

function isUUID(str: string) {
	const uuidRegex =
		/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
	return uuidRegex.test(str);
}

function validatePhoneStr(str: string) {
	const hasInvalidDigits = /\D/.test(str);
	const hasInvalidLength = str.length < 10;

	return !hasInvalidDigits && !hasInvalidLength;
}

export {
	mapToParsedMessage,
	isMessageFromNow,
	parseMessage,
	formatToOpusAudio,
	logWithDate,
	getAllEndpoints,
	isUUID,
	decodeSafeURI,
	filesPath,
	encodeParsedMessage,
	decodeParsedMessage,
	validatePhoneStr
};
