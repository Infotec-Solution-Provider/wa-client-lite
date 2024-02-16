import { Request, Response, Router } from "express";
import multer from "multer";
import instances from "./instances";
import { decodeSafeURI, filesPath, isUUID, logWithDate } from "./utils";
import * as mime from "mime";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import axios from "axios";
import { config } from "dotenv";

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
        this.router.get("/clients/:from/validate-number/:to", this.validateNumber);
        this.router.post("/clients/:from/messages/:to", upload.single("file"), this.sendMessage);
        this.router.post("/clients/:from/mass-messages/:from", upload.single("file"), this.sendMassMessages)
        this.router.get("/files/:filename", this.getFile);
        this.router.post("/files", upload.single("file"), this.uploadFile);
    }

    async loadMessages(req: Request, res: Response) {
        try {
            const instance = instances.find(req.params.from);

            if (!instance) {
                res.status(404).send();
                return;
            }

            const result = await instance.loadMessages();
            res.status(200).json(result);
        } catch (err: any) {
            res.status(500).send(err);
        }
    }

    async loadAvatars(req: Request, res: Response) {
        try {
            const instance = instances.find(req.params.from);

            if (!instance) {
                res.status(404).send();
                return;
            }

            const result = await instance.loadAvatars();
            res.status(200).json(result)
        } catch (err: any) {
            res.status(500).send(err);
        }
    }

    async sendMessage(req: Request, res: Response) {
        try {
            const { from, to } = req.params;
            const instance = instances.find(from);

            if (!instance) {
                return res.status(404).json({ message: "Whatsapp number isn't found " });
            }

            const { text, referenceId, filename, isAudio } = req.body;
            const file = req.file;

            console.log(req.body);

            if (file) {
                const sentMessageWithFile = await instance.sendFile({
                    file: file.buffer,
                    fileName: decodeSafeURI(file.originalname),
                    mimeType: file.mimetype,
                    contact: to,
                    caption: text,
                    quotedMessageId: referenceId,
                    isAudio
                });

                res.status(201).json(sentMessageWithFile);
            } else if (filename) {
                console.log("Filename => ", filename);
                const filePath = join(filesPath, '/media', filename)
                const localfile = readFileSync(filePath);
                const mimeType = mime.getType(filePath);

                const fileNameWithoutUUID = filename.split("_").slice(1).join("_");

                const sentMessageWithFile = await instance.sendFile({
                    file: localfile,
                    fileName: fileNameWithoutUUID,
                    mimeType: mimeType || "unknown",
                    contact: to,
                    caption: text
                })

                res.status(201).json(sentMessageWithFile);
            } else {
                const sentMessage = await instance.sendText(to, text, referenceId);

                res.status(201).json(sentMessage);
            }

        } catch (err) {
            logWithDate("[router.js] Send message failure =>", err);
        }
    }

    async getProfilePic(req: Request, res: Response) {
        try {
            const { from, to } = req.params;

            const instance = instances.find(from);

            if (!instance) {
                return res.status(404).json({ message: "Whatsapp number isn't found " });
            }

            const pfpURL = await instance.getProfilePicture(to);

            res.status(200).json({ url: pfpURL });
        } catch {
            res.status(500).send();
        }

    }

    async getFile(req: Request, res: Response) {
        try {
            const filesPath = process.env.FILES_DIRECTORY!;
            const fileName = req.params.filename;
            const searchFilePath = join(filesPath, "/media", fileName);

            if (!existsSync(searchFilePath)) {
                return res.status(404).json({ message: "File not found" });
            }
            const mimeType = mime.getType(searchFilePath);
            const file = readFileSync(searchFilePath);
            const haveUUID = isUUID(fileName.split("_")[0])
            const fileNameWithoutUUID = haveUUID ? fileName.split("_").slice(1).join("_") : fileName;

            res.setHeader('Content-Disposition', `inline; filename="${fileNameWithoutUUID}"`);
            mimeType && res.setHeader('Content-Type', mimeType);
            res.end(file);

            logWithDate("Get file success =>", fileName);
        } catch (err) {
            // Log and send error response
            logWithDate("Get file failure =>", err);
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
                const status = await instance.client.getState().catch(() => undefined);
                const instanceData = {
                    client: instance.clientName,
                    number: instance.whatsappNumber,
                    auth: instance.isAuthenticated,
                    ready: instance.isReady,
                    status
                };

                clientsStatus.push(instanceData)
            }

            logWithDate("Get clients statuses success!");
            res.status(200).json({ instances: clientsStatus });
        } catch (err) {
            logWithDate("Get clients statuses failure => ", err);
            res.status(500).json({ message: "Something went wrong" });
        }
    }

    async uploadFile(req: Request, res: Response) {
        try {
            if (!req.file) {
                res.status(400).send();
                return;
            }

            const uuid = randomUUID();
            const filename = decodeURIComponent(req.file.originalname).split(".")[0]
            const ext = decodeURIComponent(req.file.originalname).split(".")[1]
            const generatedName = `${uuid}_${filename}.${ext}`;

            const filesPath = process.env.FILES_DIRECTORY!;
            const filePath = join(filesPath, "/media", generatedName);

            writeFileSync(filePath, req.file.buffer);

            res.status(201).json({ filename: generatedName });

        } catch (err) {
            logWithDate("Upload file failure => ", err);
            res.status(500).json({ message: "Something went wrong" });
        }
    }

    async sendMassMessages(req: Request, res: Response) {
        const { file, body, params } = req;
        const { contacts, text, mode } = body;
        const { from } = params;

        const instance = instances.find(from);

        if (!instance) {
            res.status(404).send();
            return;
        }

        res.status(200).send();

        const sendMM = async (contacts: string[], file: Express.Multer.File) => {
            try {
                const contact = contacts[0];

                const haveUUID = isUUID(file.originalname.split("_")[0])
                const fileName = haveUUID ? file.originalname.split("_").slice(1).join("_") : file.originalname;

                const parsedMessage = file ?
                    await instance.sendFile({
                        caption: text,
                        contact,
                        file: file.buffer,
                        fileName: fileName,
                        mimeType: file.mimetype
                    })
                    :
                    await instance.sendText(contact, text);

                await axios.post(`${instance.requestURL.replace("/wwebjs", "")}/custom-routes/receive_mm/${instance.whatsappNumber}/${contact}`, parsedMessage);
                const randomInterval = 5000 + (Math.random() * 5000);

                contacts.shift()

                setTimeout(() => {
                    sendMM(contacts, file);
                }, randomInterval);

            } catch (err) {
                logWithDate(`Send MM Failure =>`, err);
            }
        }

        if (mode === "0" && file) sendMM(contacts, file);
    }

    async validateNumber(req: Request, res: Response) {
        try {
            const { from, to } = req.params;

            const instance = instances.find(from);

            if (!instance) {
                res.status(404).send();
                return;
            }

            const validNumber = await instance.validateNumber(to);

            res.status(200).json({ validNumber });
        } catch (err) {
            logWithDate("Validate number failure => ", err);
            res.status(500).json({ message: "Something went wrong" });
        }
    }
}

export default AppRouter;