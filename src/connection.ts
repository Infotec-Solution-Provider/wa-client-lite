import "dotenv/config";
import { createPool } from "mysql2/promise";
import { ConnectionOptions } from "mysql2/promise";

const connectionProps: ConnectionOptions = {
    host: process.env["DATABASE_HOST"]!,
    user: process.env["DATABASE_USER"]!,
    password: process.env["DATABASE_PASSWORD"]!,
    database: process.env["DATABASE_DATABASE"]!,
}

const whatsappClientPool = createPool(connectionProps);

export default whatsappClientPool;