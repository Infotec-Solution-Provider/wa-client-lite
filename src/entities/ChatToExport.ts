import toChatHtml from "../resources/pdf-html";
import { SavedMessage } from "../types";

export default class ChatToExport {
    private contact: { id: number; name: string; phone: string; customerId: number; };
    private user: { id: number; name: string; };
    private messages: SavedMessage[] = [];

    constructor(contact: { id: number; name: string; phone: string; customerId: number; }, user: { id: number; name: string; }) {
        this.contact = contact;
        this.user = user;
    }

    public push(message: SavedMessage | SavedMessage[]) {
        if (Array.isArray(message)) {
            this.messages.push(...message);
        }
        else {
            this.messages.push(message);
        }
    }

    public getMessages() {
        return this.messages;
    }

    public getContact() {
        return this.contact;
    }

    public getUser() {
        return this.user;
    }

    public toHtml(clientName: string) {
        return toChatHtml(clientName, this);
    }
}