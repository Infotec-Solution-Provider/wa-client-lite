# 📝 Tipos e Interfaces TypeScript

Este documento descreve os principais tipos e interfaces utilizados no WA Client Lite.

---

## SendFileOptions

Opções para envio de arquivos.

```typescript
interface SendFileOptions {
    contact: string;          // Número do destinatário
    file: any;                // Buffer do arquivo
    mimeType: string;         // Tipo MIME (ex: "image/jpeg")
    fileName: string;         // Nome do arquivo
    caption?: string;         // Legenda (opcional)
    quotedMessageId?: string; // ID da mensagem para responder (opcional)
    isAudio?: "true" | "false"; // Se é áudio de voz (opcional)
}
```

---

## WhatsappInstanceType

Tipos de implementação suportados.

```typescript
type WhatsappInstanceType = "WWEBJS" | "BAILEYS";
```

| Tipo | Descrição |
|------|-----------|
| `WWEBJS` | whatsapp-web.js (usa Puppeteer) |
| `BAILEYS` | @whiskeysockets/baileys (WebSocket direto) |

---

## DBWhatsappInstance

Estrutura de uma instância no banco de dados.

```typescript
interface DBWhatsappInstance {
    readonly number: string;              // Número do WhatsApp
    readonly client_name: string;         // Nome do cliente
    readonly is_active: boolean;          // Se está ativa
    readonly created_at: string;          // Data de criação
    readonly updated_at: string;          // Data de atualização
    readonly inactivated_at: string | null; // Data de inativação
    readonly db_host: string;             // Host do banco do cliente
    readonly db_port: number;             // Porta do banco
    readonly db_user: string;             // Usuário do banco
    readonly db_pass: string;             // Senha do banco
    readonly db_name: string;             // Nome do banco
    readonly type: WhatsappInstanceType;  // Tipo de implementação
}
```

---

## DBAutomaticMessage

Configuração de mensagem automática.

```typescript
interface DBAutomaticMessage {
    readonly id: number;                  // ID único
    readonly instance_number: string;     // Número da instância
    readonly text: string;                // Texto da mensagem
    readonly attachment: string;          // Nome do arquivo de anexo
    readonly attachment_type: AttachmentType; // Tipo do anexo
    readonly send_condition: string;      // Condição (JSON)
    readonly send_max_times: number;      // Máximo de envios por contato
}
```

---

## ParsedMessage

Mensagem parseada para envio/recebimento.

```typescript
interface ParsedMessage {
    ID: string;                 // ID único da mensagem
    ID_REFERENCIA?: string;     // ID da mensagem referenciada
    TIPO: string;               // Tipo (chat, image, document, etc)
    MENSAGEM: string;           // Conteúdo da mensagem
    TIMESTAMP: number;          // Timestamp em milissegundos
    FROM_ME: boolean;           // Se foi enviada pelo sistema
    DATA_HORA: Date;            // Data/hora
    STATUS: string;             // Status (PENDING, SENT, READ, etc)
    ARQUIVO: null | {
        NOME_ARQUIVO: string;   // Nome salvo do arquivo
        TIPO: string;           // MIME type
        NOME_ORIGINAL: string;  // Nome original
        ARMAZENAMENTO: string;  // Local de armazenamento
    }
}
```

---

## Attendance

Dados de um atendimento.

```typescript
interface Attendance {
    CODIGO: number;                           // ID do atendimento
    ATIVO_RECEP: 'ATIVO' | 'RECEP';          // Tipo
    CODIGO_OPERADOR: number;                  // ID do operador
    CODIGO_OPERADOR_ANTERIOR: number;         // ID do operador anterior
    CODIGO_CLIENTE: number;                   // ID do cliente
    CODIGO_NUMERO: number;                    // ID do número
    CODIGO_CC: number;                        // ID do centro de custo
    CONCLUIDO: boolean;                       // Se está concluído
    DATA_INICIO: Date | null;                 // Data de início
    DATA_FIM: Date | null;                    // Data de fim
    DATA_AGENDAMENTO: Date | null;            // Data de agendamento
    AGUARDANDO_RETORNO: 'SIM' | 'NAO';       // Aguardando retorno
    URGENCIA_SUPERVISOR: 'URGENTE' | 'MUITO_ALTA' | 'ALTA' | 'MEDIA' | 'NORMAL';
    URGENCIA_AGENDAMENTO: 'MUITO_ALTA' | 'ALTA' | 'MEDIA' | 'NORMAL';
    URGENCIA_OPERADOR: 'ALTA' | 'MEDIA' | 'NORMAL';
    SETOR: number;                            // ID do setor
    TIPO: string;                             // Tipo do atendimento
    SETOR_VENDAS: number;                     // ID do setor de vendas
    AVATAR_URL: string;                       // URL do avatar
}
```

---

## AttendanceWithContact

Atendimento com dados do contato.

```typescript
interface AttendanceWithContact extends Attendance {
    CONTATO_NUMERO: string;  // Número do contato
}
```

---

## AttachmentType

Tipos de anexo suportados.

```typescript
type AttachmentType = 
    | "contact"    // Cartão de contato
    | "document"   // Documento
    | "image"      // Imagem
    | "video"      // Vídeo
    | "audio"      // Arquivo de áudio
    | "voice"      // Mensagem de voz (PTT)
    | "location"   // Localização
    | null;        // Sem anexo
```

---

## ExportMessagesOptions

Opções para exportação de mensagens.

```typescript
interface ExportMessagesOptions {
    clientName: string;           // Nome do cliente
    userId: number | string;      // ID do usuário
    startDate: string;            // Data inicial (YYYY-MM-DD)
    endDate: string;              // Data final (YYYY-MM-DD)
    includeFiles: boolean;        // Incluir arquivos
    format: "txt" | "pdf" | "csv"; // Formato de exportação
}
```

---

## SavedMessage

Mensagem salva no banco de dados.

### Sem arquivo

```typescript
interface SavedMessageWithoutFile {
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
```

### Com arquivo

```typescript
interface SavedMessageWithFile extends SavedMessageWithoutFile {
    ARQUIVO_NOME: string;
    ARQUIVO_TIPO: string;
    ARQUIVO_NOME_ORIGINAL: string;
}
```

### Union Type

```typescript
type SavedMessage = SavedMessageWithoutFile | SavedMessageWithFile;
```

---

## InpulseUser

Dados de usuário do sistema Inpulse.

```typescript
interface InpulseUser {
    CODIGO: number;  // ID do usuário
    NOME: string;    // Nome do usuário
}
```

---

## AnyWhatsappInstance

Union type para qualquer tipo de instância.

```typescript
type AnyWhatsappInstance = WhatsappInstance | WhatsappBaileysInstance;
```

---

## Uso em Type Guards

```typescript
// Verificar tipo de instância
if (instance instanceof WhatsappBaileysInstance) {
    // Código específico para Baileys
    await instance.loadContacts();
}

if (instance instanceof WhatsappInstance) {
    // Código específico para WWEBJS
    await loadContacts(instance);
}
```

---

## Dicas de TypeScript

### Narrowing com Type Guards

```typescript
function hasFile(message: SavedMessage): message is SavedMessageWithFile {
    return 'ARQUIVO_NOME' in message;
}

if (hasFile(savedMessage)) {
    console.log(savedMessage.ARQUIVO_NOME); // TypeScript sabe que é SavedMessageWithFile
}
```

### Readonly para Imutabilidade

```typescript
interface DBWhatsappInstance {
    readonly number: string;  // Não pode ser alterado
    // ...
}
```

### Optional Properties

```typescript
interface SendFileOptions {
    caption?: string;  // O ? indica que é opcional
    // ...
}
```
