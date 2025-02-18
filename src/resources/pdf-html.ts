import ChatToExport from "../entities/ChatToExport";
import { getAttachmentType, toDownloadLink } from "../functions/exportMessages";
import { SavedMessage, SavedMessageWithFile } from "../types";
import { formatPhone } from "../utils";

const pdfStyle = `<style>
* {
  margin: 0;
  padding: 0;
  line-height: 100%;
}

body {
  font-family: 'Lucida Sans', 'Lucida Sans Regular', 'Lucida Grande', 'Lucida Sans Unicode', Geneva, Verdana, sans-serif;
  padding: 0.5rem;
  margin: 0;
}

.pdf-header {
  background-color: rgba(255, 85, 0, 0.95);
  color: rgb(250, 242, 242);
  padding: 0.25rem;
  display: flex;
  align-items: center;
  border-radius: 0.125rem;
  font-size: 0.875rem;
}

.pdf-header p {
  margin: 0.125rem;
}

.pdf-header svg {
  transform: scale(0.625);
}

ul {
  box-sizing: border-box;
  margin-top: 0.375rem;
  padding: 1rem;
  background-color: rgb(231,223,216);
  width: 100%;
  height: max-content;
  border-radius: 0.125rem;
  list-style: none;
}


.message-container {
  border-radius: 0.125rem;
  padding: 0.5rem;
  font-size: 0.75rem;
  width: max-content;
  max-width: 66%;
  margin-bottom: 0.5rem;

  -webkit-box-shadow: 1px 1px 1px 1px rgba(82,82,82, 50%);
  -moz-box-shadow: 1px 1px 1px 1px rgba(82,82,82, 50%);
  box-shadow: 1px 1px 1px 1px rgba(82,82,82, 50%);
}

.message-container.from-user {
  background-color: rgb(220,248,198);
  margin-left: auto;
}

.message-container.from-customer {
  background-color: rgb(255, 255, 255);
}

.message-container .data {
  margin-top: 0.25rem;
  font-size: 0.625rem;
}

.message-container .data b {
  font-weight: 500;
  color: rgb(50, 75, 185);
}

.message-container .attachment {
  margin-top: 0.25rem;
  font-size: 0.625rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.message-container .attachment a {
  max-width: 25rem;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
  display: inline-block;
}

.message-container .attachment svg {
  width: 0.675rem;
  display: inline-block;
  margin: 0;
  padding: 0;
}

.message-container .attachment img {
  background-color: white;
  background-size: contain;
  padding: 0.5rem;
  margin: auto;
  width: 100%;
  max-height: 20rem;
}
</style>
`;

const htmlHeader = (contactName: string, phone: string) => {
    const formattedPhone = formatPhone(phone);

    return `<header class="pdf-header">
	<p>
		<b>Contato:</b> ${contactName}
		|
		<b>Número:</b> ${formattedPhone}
	</p>
</header>`;
}


const htmlMessage = (clientName: string, message: SavedMessage, userName: string) => {
    const messageContentElement = `<section>
    ${message.MENSAGEM.split("\n").map((line) => `<p>${line}</p>`).join("")}
</section>`;

    const messageDataElement = `<section class="data">
    <b>${!!message.FROM_ME ? userName : message.CONTATO_NOME}</b>
    <span>${message.DATA_HORA.toLocaleString()}</span>
</section>`;

    const castedMessage = message as SavedMessageWithFile;

    if (castedMessage.ARQUIVO_NOME) {
        const attachmentLink = toDownloadLink(castedMessage, clientName);
        const attachmentType = getAttachmentType(castedMessage.ARQUIVO_TIPO);
        const attachmentElement = `
            <section class="attachment">
                <span>(${attachmentType})</span> <a href="${attachmentLink}">${castedMessage.ARQUIVO_NOME_ORIGINAL || castedMessage.ARQUIVO_NOME}</a>
            </section>`;

        if (attachmentType === "Imagem") {
            const imageElement = `
                <section class="attachment">
                    <img src="${attachmentLink}" alt="${castedMessage.ARQUIVO_NOME_ORIGINAL || castedMessage.ARQUIVO_NOME}" />
                </section>`;

            return `
                <li class="message-container ${message.FROM_ME ? "from-user" : "from-customer"}">
                    ${messageContentElement}
                    ${attachmentElement}
                    ${imageElement}
                    ${messageDataElement}
                </li>`;
        }

        return `
        <li class="message-container ${message.FROM_ME ? "from-user" : "from-customer"}">
            ${messageContentElement}
            ${attachmentElement}
            ${messageDataElement}
        </li>`;
    }

    return `
    <li class="message-container ${message.FROM_ME ? "from-user" : "from-customer"}">
        ${messageContentElement}
        ${messageDataElement}
    </li>`;
}

export default function toChatHtml(clientName: string, chat: ChatToExport) {
    const messages = chat.getMessages().map((m) => htmlMessage(clientName, m, chat.getUser().name)).join("");

    return `
    <!DOCTYPE html>
    <html lang="pt-br">
        <head>
            ${pdfStyle}
        </head>
        <body>
            ${htmlHeader(chat.getContact().name, chat.getContact().phone)}
            <ul>
                ${messages}
            </ul>
        </body>
    </html>`;
};