import { config } from "dotenv";
import { Request, Response, Router } from "express";
import * as mime from "mime";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadContacts } from "./functions/loadContacts";
import instances from "./instances";
import { decodeSafeURI, filesPath, isUUID, logWithDate } from "./utils";
import WhatsappInstance from "./whatsapp";
import WhatsappBaileysInstance from "./whatsapp-baileys";

config();

class AppRouter {
	public readonly router = Router();

	constructor() {
		const upload = multer();

		this.router.get("", this.healthCheck);
		this.router.get("/clients", this.getClientStatus);
		this.router.get("/clients/:from/avatars/:to", this.getProfilePic);
		this.router.get("/clients/:from/load-messages", this.loadMessages);
		this.router.get("/clients/:from/load-avatars", this.loadAvatars);
		this.router.get("/clients/:from/load-contacts", this.loadContacts);
		this.router.get("/clients/:from/contacts-stats", this.getContactsStats);
		this.router.post("/clients/:from/sync-contacts-from-messages", this.syncContactsFromMessages);
		this.router.get("/clients/:from/validate-number/:to", this.validateNumber);
		this.router.get("/files/:filename", this.getFile);
		this.router.post("/files", upload.single("file"), this.uploadFile);
		this.router.post("/clients/:from/messages/:to", upload.single("file"), this.sendMessage);
	}


	async loadMessages(req: Request, res: Response) {
		try {
			const from = req.params["from"];
			if (!from) {
				return res.status(400).send("Parameter 'from' is required");
			}
			const instance = instances.find(from);

			if (!instance) {
				return res.status(404).send();
			}

			const result = await instance.loadMessages();
			return res.status(200).json(result);
		} catch (err: any) {
			return res.status(500).send(err);
		}
	}

	async loadAvatars(req: Request, res: Response) {
		try {
			const from = req.params["from"];
			if (!from) {
				return res.status(400).send("Parameter 'from' is required");
			}
			const instance = instances.find(from);

			if (!instance) {
				return res.status(404).send();
			}

			const result = await instance.loadAvatars();
			return res.status(200).json(result);
		} catch (err: any) {
			return res.status(500).send(err);
		}
	}

	async loadContacts(req: Request, res: Response) {
		try {
			const from = req.params["from"];
			if (!from) {
				return res.status(400).send("Parameter 'from' is required");
			}
			const instance = instances.find(from);
			if (!instance) {
				return res.status(404).send();
			}

			// Suporte para Baileys
			if (instance instanceof WhatsappBaileysInstance) {
				const result = await instance.loadContacts();

				if (result.alreadyRunning) {
					return res.status(409).json({ message: "Load contacts is already running for this instance" });
				}

				return res.status(200).json({ 
					message: "Load contacts completed", 
					total: result.total,
					saved: result.saved,
					skipped: result.skipped,
					errors: result.errors
				});
			}

			// Suporte para WebJS
			if (instance instanceof WhatsappInstance) {
				const result = await loadContacts(instance);

				if (result.alreadyRunning) {
					return res.status(409).json({ message: "Load contacts is already running for this instance" });
				}

				return res.status(200).json({ message: "Load contacts started" });
			}

			return res.status(400).send("Unknown instance type");
		} catch (err: any) {
			return res.status(500).send(err);
		}
	}

	async getContactsStats(req: Request, res: Response) {
		try {
			const from = req.params["from"];
			if (!from) {
				return res.status(400).send("Parameter 'from' is required");
			}
			const instance = instances.find(from);
			if (!instance) {
				return res.status(404).send();
			}

			// Apenas para Baileys
			if (instance instanceof WhatsappBaileysInstance) {
				const result = await instance.getContactsStats();
				return res.status(200).json(result);
			}

			return res.status(400).send("This endpoint is only available for Baileys instances");
		} catch (err: any) {
			return res.status(500).send(err);
		}
	}

	async syncContactsFromMessages(req: Request, res: Response) {
		try {
			const from = req.params["from"];
			if (!from) {
				return res.status(400).send("Parameter 'from' is required");
			}
			const instance = instances.find(from);
			if (!instance) {
				return res.status(404).send();
			}

			// Apenas para Baileys
			if (instance instanceof WhatsappBaileysInstance) {
				const result = await instance.syncContactsFromMessages();
				return res.status(200).json({
					message: "Sync contacts from messages completed",
					...result
				});
			}

			return res.status(400).send("This endpoint is only available for Baileys instances");
		} catch (err: any) {
			return res.status(500).send(err);
		}
	}

	async sendMessage(req: Request, res: Response) {
		try {
			const from = req.params["from"];
			const to = req.params["to"];

			if (!from || !to) {
				return res.status(400).json({ message: "Parameters 'from' and 'to' are required" });
			}

			const instance = instances.find(from);

			if (!instance) {
				return res.status(404).json({ message: "Whatsapp number isn't found " });
			}

			const { text, referenceId, filename, isAudio } = req.body;
			const file = req.file;

			if (file) {
				const sentMessageWithFile = await instance.sendFile({
					file: file.buffer,
					fileName: decodeSafeURI(file.originalname),
					mimeType: file.mimetype,
					contact: to,
					caption: text,
					quotedMessageId: referenceId,
					isAudio,
				});

				return res.status(201).json(sentMessageWithFile);
			} else if (filename) {
				const filePath = join(filesPath, "/media", filename);
				const localfile = readFileSync(filePath);
				const mimeType = mime.getType(filePath);

				const fileNameWithoutUUID = filename.split("_").slice(1).join("_");

				const sentMessageWithFile = await instance.sendFile({
					file: localfile,
					fileName: fileNameWithoutUUID,
					mimeType: mimeType || "unknown",
					contact: to,
					caption: text,
				});

				return res.status(201).json(sentMessageWithFile);
			} else {
				const sentMessage = await instance.sendText(to, text, referenceId);

				return res.status(201).json(sentMessage);
			}
		} catch (err) {
			logWithDate("[router.js] Send message failure =>", err);
			
			// Check if it's a connection error
			if (err instanceof Error) {
				if (err.message.includes("Connection not ready") || 
				    err.message.includes("Connection Closed") ||
				    err.message.includes("Client not connected")) {
					return res.status(503).json({ 
						message: "WhatsApp connection is not ready. Please wait for reconnection.",
						error: err.message 
					});
				}
			}
			
			return res.status(500).json({ message: "Something went wrong" });
		}
	}

	async getProfilePic(req: Request, res: Response) {
		try {
			const from = req.params["from"];
			const to = req.params["to"];

			if (!from || !to) {
				return res.status(400).json({ message: "Parameters 'from' and 'to' are required" });
			}

			const instance = instances.find(from);

			if (!instance) {
				return res.status(404).json({ message: "Whatsapp number isn't found " });
			}

			const pfpURL = await instance.getProfilePicture(to);

			return res.status(200).json({ url: pfpURL });
		} catch {
			return res.status(500).send();
		}
	}

	async getFile(req: Request, res: Response) {
		try {
			const filesDirectory = process.env["FILES_DIRECTORY"]!;
			const fileName = req.params["filename"];

			if (!fileName) {
				return res.status(400).json({ message: "filename is required" });
			}

			const searchFilePath = join(filesDirectory, "/media", fileName);

			if (!existsSync(searchFilePath)) {
				return res.status(404).json({ message: "File not found" });
			}
			const mimeType = mime.getType(searchFilePath);
			const file = readFileSync(searchFilePath);
			const firstPart = fileName.split("_")[0];
			const haveUUID = isUUID(firstPart || "");
			const fileNameWithoutUUID = haveUUID ? fileName.split("_").slice(1).join("_") : fileName;

			res.setHeader("Content-Disposition", `inline; filename="${fileNameWithoutUUID}"`);
			mimeType && res.setHeader("Content-Type", mimeType);
			res.end(file);

			logWithDate("Get file success =>", fileName);
			return;
		} catch (err) {
			// Log and send error response
			logWithDate("Get file failure =>", err);
			return res.status(500).json({ message: "Something went wrong" });
		}
	}

	async uploadFile(req: Request, res: Response) {
		try {
			if (!req.file) {
				res.status(400).send();
				return;
			}

			const uuid = randomUUID();
			const filename = decodeURIComponent(req.file.originalname).split(".")[0];
			const ext = decodeURIComponent(req.file.originalname).split(".")[1];
			const generatedName = `${uuid}_${filename}.${ext}`;

			const filesDirectory = process.env["FILES_DIRECTORY"]!;
			const filePath = join(filesDirectory, "/media", generatedName);

			writeFileSync(filePath, req.file.buffer);

			res.status(201).json({ filename: generatedName });
		} catch (err) {
			logWithDate("Upload file failure => ", err);
			res.status(500).json({ message: "Something went wrong" });
		}
	}

	async healthCheck(_: Request, res: Response) {
		res.status(200).json({ online: true });
	}

	async getClientStatus(_: Request, res: Response) {
		try {
			const clientsStatus = [];

			for (const instance of instances.instances) {
				if (instance instanceof WhatsappInstance) {
					const status = await instance.client.getState().catch(() => undefined);
					const instanceData = {
						client: instance.clientName,
						number: instance.whatsappNumber,
						auth: instance.isAuthenticated,
						ready: instance.isReady,
						status,
					};

					clientsStatus.push(instanceData);
				}
			}
			logWithDate("Get clients statuses success!");
			res.status(200).json({ instances: clientsStatus });
		} catch (err) {
			logWithDate("Get clients statuses failure => ", err);
			res.status(500).json({ message: "Something went wrong" });
		}
	}

	async validateNumber(req: Request, res: Response) {
		try {
			const from = req.params["from"];
			const to = req.params["to"];

			if (!from || !to) {
				return res.status(400).json({ message: "Parameters 'from' and 'to' are required" });
			}

			const instance = instances.find(from);

			if (!instance) {
				return res.status(404).send();
			}

			const validNumber = await instance.validateNumber(to);

			return res.status(200).json({ validNumber });
		} catch (err) {
			logWithDate("Validate number failure => ", err);
			return res.status(500).json({ message: "Something went wrong" });
		}
	}
}

export default AppRouter;
