import { RowDataPacket } from "mysql2";
import WhatsappInstance from "../whatsapp";

// Track which instances are currently loading contacts
const loadingInstances: Map<string, Promise<void>> = new Map();

export async function loadContacts(instance: WhatsappInstance): Promise<{ started: boolean; alreadyRunning: boolean }> {
    const instanceKey = `${instance.clientName}_${instance.whatsappNumber}`;

    // Check if already running for this instance
    if (loadingInstances.has(instanceKey)) {
        return { started: false, alreadyRunning: true };
    }

    // Create the loading promise
    const loadPromise = (async () => {
        try {
            const contacts = await instance.client.getContacts();

            for (const contact of contacts) {

                if (!contact.number) continue
                const numberWithoutCountry = contact.number.slice(2);
                const DDD = numberWithoutCountry.slice(0, 2);
                const numberBody = numberWithoutCountry.length === 10 ? numberWithoutCountry.slice(2) : numberWithoutCountry.slice(3);

                const [numberWithout9, numberWith9] = [numberBody, `9${numberBody}`];
                const contactName = (contact.name || contact.pushname) || contact.shortName;

                const SEARCH_CUSTOMER_QUERY = `
                SELECT * FROM clientes
                WHERE (AREA1 = ${DDD} AND FONE1 = '${numberWith9}') OR 
                      (AREA2 = ${DDD} AND FONE2 = '${numberWith9}') OR 
                      (AREA3 = ${DDD} AND FONE3 = '${numberWith9}') OR 
                      (AREA1 = ${DDD} AND FONE1 = '${numberWithout9}') OR 
                      (AREA2 = ${DDD} AND FONE2 = '${numberWithout9}') OR 
                      (AREA3 = ${DDD} AND FONE3 = '${numberWithout9}')
                    `;

                const SEARCH_CONTACT_QUERY = `
                    SELECT 
                        * 
                    FROM 
                        contatos
                    WHERE
                        (AREA_CEL = '${DDD}' AND CELULAR = '${numberWith9}') OR 
                        (AREA_CEL = '${DDD}' AND CELULAR = '${numberWithout9}') OR
                        (AREA_DIRETO = '${DDD}' AND FONE_DIRETO = '${numberWith9}') OR 
                        (AREA_DIRETO = '${DDD}' AND FONE_DIRETO = '${numberWithout9}') OR  
                        (AREA_RESI = '${DDD}' AND FONE_RESIDENCIAL = '${numberWith9}') OR 
                        (AREA_RESI = '${DDD}' AND FONE_RESIDENCIAL = '${numberWithout9}')
                    `;

                const findCustomer = await new Promise<{ CODIGO: number } | null>(async (res) => {
                    const findOnCustomers = await instance.pool
                        .query<RowDataPacket[]>(SEARCH_CUSTOMER_QUERY)
                        .then(res => res[0][0] || null)
                        .catch(err => {
                            console.error(err);
                            return null;
                        });

                    if (findOnCustomers) res(findOnCustomers as { CODIGO: number });

                    const findOnContacts = await instance.pool
                        .query<RowDataPacket[]>(SEARCH_CONTACT_QUERY)
                        .then(res => res[0][0] || null)
                        .catch(err => {
                            console.error(err);
                            return null;
                        });

                    if (findOnContacts) res(findOnContacts as { CODIGO: number });

                    res(null);
                });


                await instance.pool.query(
                    "INSERT IGNORE INTO w_clientes_numeros (CODIGO_CLIENTE, NOME, NUMERO) VALUES (?, ?, ?);",
                    [findCustomer?.CODIGO || -1, contactName || contact.number, contact.number]
                );
            }
        } finally {
            // Always remove from loading instances when done
            loadingInstances.delete(instanceKey);
        }
    })();

    // Store the promise
    loadingInstances.set(instanceKey, loadPromise);

    return { started: true, alreadyRunning: false };
}

export function isLoadingContacts(instance: WhatsappInstance): boolean {
    const instanceKey = `${instance.clientName}_${instance.whatsappNumber}`;
    return loadingInstances.has(instanceKey);
}