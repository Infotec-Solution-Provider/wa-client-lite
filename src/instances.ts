import { FieldPacket, RowDataPacket } from "mysql2";
import WhatsappInstance from "./whatsapp";
import WhatsappBaileysInstance from "./whatsapp-baileys";
import { DBWhatsappInstance } from "./types";
import "dotenv/config";
import whatsappClientPool from "./connection";

const { REQUEST_URL } = process.env;

const SELECT_INSTANCES_QUERY = `
SELECT 
    wi.*,
    db.host AS db_host,
    db.port AS db_port,
    db.user AS db_user,
    db.password AS db_pass,
    db.database AS db_name
FROM whatsapp_instances wi
LEFT JOIN clients c ON c.name = wi.client_name
LEFT JOIN database_connections db ON db.client_name = wi.client_name
WHERE c.is_active AND wi.is_active;
`;

const getURL = (client: string) => REQUEST_URL?.replace(":clientName", client) || "";

// Union type for both instance types
export type AnyWhatsappInstance = WhatsappInstance | WhatsappBaileysInstance;

class WhatsappInstances {
    public instances: Array<AnyWhatsappInstance> = [];

    constructor() {
        this.init();
    }

    private async init() {
        const [rows]: [Array<RowDataPacket>, Array<FieldPacket>] = await whatsappClientPool.query(SELECT_INSTANCES_QUERY);
        const dbInstances = rows as Array<DBWhatsappInstance>;

        this.instances = dbInstances.map(i => {
            const connectionParams = {
                host: i.db_host,
                port: i.db_port,
                user: i.db_user,
                password: i.db_pass,
                database: i.db_name
            };
            const apiUrl = getURL(i.client_name);

            switch (i.type) {
                case "BAILEYS":
                    return new WhatsappBaileysInstance(i.client_name, i.number, apiUrl, connectionParams);
                case "WWEBJS":
                    return new WhatsappInstance(i.client_name, i.number, apiUrl, connectionParams);
                default:
                    throw new Error(`Unsupported Whatsapp instance type: ${i.type}`);
            }
        });
    }

    public find(number: string): AnyWhatsappInstance | null {
        return this.instances.find((i) => i.whatsappNumber == number) || null;
    }

    public findWebJS(number: string): WhatsappInstance | null {
        return this.instances.find(
            (i): i is WhatsappInstance => i.whatsappNumber == number && i instanceof WhatsappInstance
        ) || null;
    }

    public findBaileys(number: string): WhatsappBaileysInstance | null {
        return this.instances.find(
            (i): i is WhatsappBaileysInstance => i.whatsappNumber == number && i instanceof WhatsappBaileysInstance
        ) || null
    }

    public getPool(clientName: string) {
        const instance = this.instances.find((i) => i.clientName == clientName);

        if (!instance) {
            throw new Error(`Instance ${clientName} not found`);
        }

        return instance.pool;
    }

    public async closeAll() {
        for (const instance of this.instances) {
            if (instance instanceof WhatsappBaileysInstance) {
                await instance.close();
            }
        }
    }
}

const instances = new WhatsappInstances();

export default instances;
