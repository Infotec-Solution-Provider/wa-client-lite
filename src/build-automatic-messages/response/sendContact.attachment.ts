import WAWebJS from "whatsapp-web.js";
import WhatsappInstance from "../../whatsapp";
import getSerializedId from "../../functions/getSerializedId";

async function sendContact(instance: WhatsappInstance, message: WAWebJS.Message, number: string) {
    try {

        const numberId = await instance.client.getNumberId(number);

        if (numberId) {
            const contactId = getSerializedId(numberId);
            const contact = contactId && await instance.client.getContactById(contactId);
            contact && await message.reply(contact);
        }
    } catch (err) {
        console.error(err);
    }
}

export default sendContact;
