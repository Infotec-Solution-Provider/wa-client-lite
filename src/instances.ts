import { FieldPacket, RowDataPacket } from "mysql2";
import WhatsappInstance from "./whatsapp";
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

class WhatsappInstances {
    public instances: Array<WhatsappInstance> = [];

    constructor() {
        this.init();
    }

    private async init() {
        const [rows]: [Array<RowDataPacket>, Array<FieldPacket>] = await whatsappClientPool.query(SELECT_INSTANCES_QUERY);
        const instances = rows as Array<DBWhatsappInstance>;

        this.instances = instances.map(i => (
            new WhatsappInstance(
                i.client_name,
                i.number,
                getURL(i.client_name),
                { host: i.db_host, port: i.db_port, user: i.db_user, password: i.db_pass, database: i.db_name }
            )
        ));
    }

    public find(number: string) {
        return this.instances.find((i) => i.whatsappNumber == number);
    }

    public getPool(clientName: string) {
        const instance = this.instances.find((i) => i.clientName == clientName);

        if (!instance) {
            throw new Error(`Instance ${clientName} not found`);
        }

        return instance.pool;
    }
}

const instances = new WhatsappInstances();

export default instances;
