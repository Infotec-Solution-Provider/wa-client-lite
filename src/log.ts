import path from "node:path";
import { writeFile, /* readFile */ } from "node:fs/promises";
import { mkdirp } from "mkdirp";
import WAWebJS from "whatsapp-web.js";
import { logWithDate } from "./utils";
import isOutOfTimeRange from "./build-automatic-messages/conditions/OUT_TIME_RANGE";

interface LogContext {
	clientName: string;
	type: string;
	identifier: string;
}

interface LogEvent {
	occurredAt: Date;
	description: string;
}

class Log<T> {
	private readonly context: LogContext;
	private readonly startedAt: Date;
	private readonly lines: Array<LogEvent>;
	private finishedAt: Date | null;
	private data: T | undefined;
	private error: Error | null = null;
	/* private client: WAWebJS.Client; */
	private errorFilePath: string | null = null;

	constructor(
		_: WAWebJS.Client,
		clientName: string,
		type: string,
		identifier: string,
		data?: T
	) {
		this.context = { clientName, type, identifier };
		this.startedAt = new Date();
		this.finishedAt = null;
		this.data = data;
		this.lines = [];
		/* this.client = client; */
	}

	/**
	 * Sets data using a callback function.
	 * @param cb - Callback function to modify the data.
	 */
	public setData(cb: (data: T) => T): void {
		try {
			this.data = cb(this.data!);
		} catch (error) {
			console.error("Error setting data:", error);
		}
	}

	public setError(err: Error): void {
		this.error = err;
	}

	/**
	 * Adds an event to the log.
	 * @param description - The description of the event.
	 */
	public event(description: string): void {
		this.lines.push({
			description: description,
			occurredAt: new Date(),
		});
	}

	/**
	 * Marks the log as finished.
	 */
	public finish(): void {
		this.finishedAt = new Date();
	}

	/**
	 * Saves the log to a persistent storage.
	 */
	public async save(): Promise<void> {
		try {
			this.finish();

			if (!this.finishedAt) {
				throw new Error("Cannot save log before it is finished.");
			}

			const logData = {
				context: this.context,
				startedAt: this.startedAt,
				finishedAt: this.finishedAt,
				data: this.data,
				lines: this.lines,
				error: this.error,
				errorMessage: this.error?.message,
			};

			const fileName = `${Date.now()}.json`;
			const logPath = path.join(
				process.env["ERRORS_DIRECTORY"] || "c://logs",
				this.context.clientName,
				this.context.type,
				this.context.identifier
			);
			this.errorFilePath = path.join(logPath, fileName);

			await mkdirp(logPath);
			await writeFile(
				this.errorFilePath,
				JSON.stringify(logData, null, 2)
			);
			this.notify();
		} catch (err) {
			console.error(err);
			logWithDate("log save error:", err);
		}
	}

	public async notify(): Promise<void> {
		const isBusinessTime = !isOutOfTimeRange(
			process.env["BUSINESS_TIME_START"] || "7:00",
			process.env["BUSINESS_TIME_END"] || "18:00"
		);

		const notifyOutOfBusinessTime = process.env["NOTIFY_OUTSIDE_BUSINESS_TIME"] === "true";

		if (!notifyOutOfBusinessTime && !isBusinessTime) {
			return
		}

		const notifyNumbers = (
			process.env["NOTIFY_NUMBERS"] || "555131346499"
		).split(",");


		for (const number of notifyNumbers) {
			try {
				//const fileBuffer = await readFile(this.errorFilePath);
				//const fileBase64 = fileBuffer.toString("base64");

				/* const media = new WAWebJS.MessageMedia(
					"application/json",
					fileBase64,
					this.errorFilePath.split("\\").reverse()[0]
				); */

				//const numberId = await this.client.getNumberId(number);
				//const chatId = numberId && numberId._serialized;

				console.log("notify", number);

				/* await this.client.sendMessage(chatId, media, {
					caption: `Erro: ${this.context.type} / ${this.context.identifier}`,
				}); */
			} catch (err) {
				logWithDate("log notify error:", err);
			}
		}
	}
}

export default Log;
