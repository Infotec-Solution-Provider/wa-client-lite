export interface SendFileOptions {
    contact: string;
    file: any;
    mimeType: string;
    fileName: string;
    caption?: string;
    quotedMessageId?: string;
    isAudio?: "true" | "false";
}

export interface DBWhatsappInstance {
    readonly number: string;
    readonly client_name: string;
    readonly is_active: boolean;
    readonly created_at: string;
    readonly updated_at: string;
    readonly inactivated_at: string | null;
    readonly db_host: string;
    readonly db_port: number;
    readonly db_user: string;
    readonly db_pass: string;
    readonly db_name: string;
}

export interface DBAutomaticMessage {
    readonly id: number;
    readonly instance_number: string;
    readonly text: string;
    readonly attachment: string;
    readonly attachment_type: AttachmentType;
    readonly send_condition: string;
    readonly send_max_times: number;
}

export interface ParsedMessage {
    ID: string;
    ID_REFERENCIA?: string;
    TIPO: string;
    MENSAGEM: string;
    TIMESTAMP: number;
    FROM_ME: boolean;
    DATA_HORA: Date;
    STATUS: string;
    ARQUIVO: null | {
        NOME_ARQUIVO: string;
        TIPO: string;
        NOME_ORIGINAL: string;
        ARMAZENAMENTO: string;
    }
}

export interface Attendance {
    CODIGO: number;
    ATIVO_RECEP: 'ATIVO' | 'RECEP';
    CODIGO_OPERADOR: number;
    CODIGO_OPERADOR_ANTERIOR: number;
    CODIGO_CLIENTE: number;
    CODIGO_NUMERO: number;
    CODIGO_CC: number;
    CONCLUIDO: boolean;
    DATA_INICIO: Date | null;
    DATA_FIM: Date | null;
    DATA_AGENDAMENTO: Date | null;
    AGUARDANDO_RETORNO: 'SIM' | 'NAO';
    URGENCIA_SUPERVISOR: 'URGENTE' | 'MUITO_ALTA' | 'ALTA' | 'MEDIA' | 'NORMAL';
    URGENCIA_AGENDAMENTO: 'MUITO_ALTA' | 'ALTA' | 'MEDIA' | 'NORMAL';
    URGENCIA_OPERADOR: 'ALTA' | 'MEDIA' | 'NORMAL';
    SETOR: number;
    TIPO: string;
    SETOR_VENDAS: number;
    AVATAR_URL: string;
}

export interface AttendanceWithContact extends Attendance {
    CONTATO_NUMERO: string;
}

export type AttachmentType = "contact" | "document" | "image" | "video" | "audio" | "voice" | "location" | null;

export interface ExportMessagesOptions {
    clientName: string;
    userId: number | string;
    startDate: string;
    endDate: string;
    format: "txt" | "pdf" | "csv";
}

export interface SavedMessageWithoutFile {
    CODIGO_ATENDIMENTO: number;
    CODIGO_OPERADOR: number;
    CODIGO_NUMERO: number;
    CONTATO_NOME: string;
    CONTATO_NUMERO: string;
    CONTATO_CLIENTE: number;
    TIPO: string;
    MENSAGEM: string | null;
    FROM_ME: boolean | number;
    DATA_HORA: Date;
    TIMESTAMP: number;
    ID: string;
    ID_REFERENCIA: string | null;
    STATUS: string;
    LOCAL_ID: string;
}

export interface SavedMessageWithFile extends SavedMessageWithoutFile {
    ARQUIVO_NOME: string;
    ARQUIVO_TIPO: string;
    ARQUIVO_NOME_ORIGINAL: string;
}

export type SavedMessage = SavedMessageWithoutFile | SavedMessageWithFile;

export interface InpulseUser {
    CODIGO: number;
    NOME: string;
}