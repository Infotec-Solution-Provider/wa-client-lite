// sendLocation.attachment.ts
import WAWebJS from "whatsapp-web.js";

async function sendLocation(message: WAWebJS.Message, locationData: string) {
    const [lat, lon] = locationData.replace(" ", "").split(",").map(s => Number(s));

    const location = new WAWebJS.Location(lat!, lon!);
    await message.reply(location);
}

export default sendLocation;