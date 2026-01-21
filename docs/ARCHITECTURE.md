# 🏗 Arquitetura do Sistema

Este documento descreve a arquitetura e os principais componentes do WA Client Lite.

## Visão Geral

O WA Client Lite é um serviço Node.js/TypeScript que gerencia múltiplas instâncias de WhatsApp, permitindo integração com sistemas backend via API REST e callbacks.

```
                                    ┌─────────────────────┐
                                    │   Backend Server    │
                                    │  (REQUEST_URL)      │
                                    └──────────┬──────────┘
                                               │
                                    ┌──────────▼──────────┐
                                    │    WA Client Lite   │
                                    │      (Port 7000)    │
                                    └──────────┬──────────┘
                                               │
                    ┌──────────────────────────┼──────────────────────────┐
                    │                          │                          │
          ┌─────────▼─────────┐    ┌───────────▼──────────┐    ┌─────────▼─────────┐
          │   Instance 1      │    │    Instance 2        │    │   Instance N      │
          │   (WWEBJS)        │    │    (Baileys)         │    │   (Any type)      │
          │   Client A        │    │    Client B          │    │   Client X        │
          └─────────┬─────────┘    └───────────┬──────────┘    └─────────┬─────────┘
                    │                          │                          │
                    └──────────────────────────┼──────────────────────────┘
                                               │
                                    ┌──────────▼──────────┐
                                    │   WhatsApp Servers  │
                                    └─────────────────────┘
```

---

## Componentes Principais

### 1. App (`src/app.ts`)

Ponto de entrada da aplicação. Inicializa o servidor Express na porta 7000.

```typescript
// Responsabilidades:
// - Criar instância Express
// - Registrar rotas
// - Iniciar servidor HTTP
```

### 2. Router (`src/router.ts`)

Gerencia todas as rotas da API REST.

```typescript
// Endpoints:
// - GET /whatsapp                           -> Health check
// - GET /whatsapp/clients                   -> Status dos clientes
// - GET /whatsapp/clients/:from/avatars/:to -> Foto de perfil
// - GET /whatsapp/clients/:from/load-messages
// - GET /whatsapp/clients/:from/load-avatars
// - GET /whatsapp/clients/:from/load-contacts
// - GET /whatsapp/clients/:from/validate-number/:to
// - GET /whatsapp/files/:filename           -> Download de arquivo
// - POST /whatsapp/files                    -> Upload de arquivo
// - POST /whatsapp/clients/:from/messages/:to -> Enviar mensagem
```

### 3. Instances Manager (`src/instances.ts`)

Gerenciador central de todas as instâncias WhatsApp.

```typescript
class WhatsappInstances {
    instances: Array<AnyWhatsappInstance>;
    
    // Busca instância pelo número
    find(number: string): AnyWhatsappInstance | null;
    
    // Busca específica por tipo
    findWebJS(number: string): WhatsappInstance | null;
    findBaileys(number: string): WhatsappBaileysInstance | null;
    
    // Obtém pool de conexão do cliente
    getPool(clientName: string): Pool;
}
```

### 4. WhatsApp Instance - WWEBJS (`src/whatsapp.ts`)

Implementação usando whatsapp-web.js (Puppeteer).

```typescript
class WhatsappInstance {
    client: WAWebJS.Client;
    
    // Eventos principais:
    // - qr          -> Gera QR Code
    // - authenticated -> Autenticado
    // - ready       -> Pronto para uso
    // - message     -> Nova mensagem
    // - message_ack -> Atualização de status
    
    // Métodos principais:
    sendText(to, text, referenceId?): Promise<ParsedMessage>;
    sendFile(options: SendFileOptions): Promise<ParsedMessage>;
    validateNumber(number): Promise<string | null>;
    getProfilePicture(number): Promise<string | null>;
    loadMessages(): Promise<object>;
    loadAvatars(): Promise<object>;
}
```

### 5. WhatsApp Instance - Baileys (`src/whatsapp-baileys.ts`)

Implementação usando @whiskeysockets/baileys (WebSocket).

```typescript
class WhatsappBaileysInstance {
    client: WASocket | null;
    
    // Eventos principais (connection.update):
    // - qr          -> Gera QR Code
    // - open        -> Conectado
    // - close       -> Desconectado
    
    // Eventos (messages.upsert):
    // - Novas mensagens recebidas/enviadas
    
    // Métodos equivalentes ao WWEBJS
    sendText(to, text, referenceId?): Promise<ParsedMessage>;
    sendFile(options: SendFileOptions): Promise<ParsedMessage>;
    validateNumber(number): Promise<string | null>;
    getProfilePicture(number): Promise<string | null>;
    loadMessages(): Promise<object>;
    loadAvatars(): Promise<object>;
    loadContacts(): Promise<object>;
}
```

### 6. Connection Pool (`src/connection.ts`)

Pool de conexão MySQL para o banco de dados principal.

```typescript
// Configuração via variáveis de ambiente:
// - DATABASE_HOST
// - DATABASE_USER
// - DATABASE_PASSWORD
// - DATABASE_DATABASE
```

### 7. Utils (`src/utils.ts`)

Funções utilitárias usadas em todo o projeto.

```typescript
// Funções principais:
logWithDate(message, ...args)           // Log com timestamp
parseMessage(message)                   // Parsear mensagem WWEBJS
mapToParsedMessage(message)            // Mapear mensagem Baileys
encodeParsedMessage(message)           // Codificar para envio
formatToOpusAudio(buffer)              // Converter áudio para Opus
validatePhoneStr(phone)                // Validar formato de telefone
isMessageFromNow(message)              // Verificar se mensagem é recente
getAllEndpoints(router, prefix)         // Listar endpoints
```

---

## Fluxo de Mensagens

### Recebimento de Mensagem

```
WhatsApp Server
      │
      ▼
┌─────────────────┐
│  Instance       │  <- Evento: message/messages.upsert
│  (WWEBJS/Baileys)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Parse Message   │  <- parseMessage() / mapToParsedMessage()
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌───────┐ ┌───────────────┐
│ Queue │ │ Check Auto    │
│       │ │ Messages      │
└───┬───┘ └───────┬───────┘
    │             │
    ▼             ▼
┌─────────────────────────┐
│ Save to Local DB        │
│ (messages table)        │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ Send to Backend         │
│ POST /messages/:number  │
└─────────────────────────┘
```

### Envio de Mensagem

```
┌─────────────────────────────┐
│ POST /clients/:from/messages│
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Find Instance by Number     │
└──────────────┬──────────────┘
               │
         ┌─────┴─────┐
         │           │
         ▼           ▼
   ┌──────────┐ ┌──────────┐
   │ Has File │ │ Text Only│
   └────┬─────┘ └────┬─────┘
        │            │
        ▼            ▼
  ┌───────────┐ ┌───────────┐
  │ sendFile()│ │ sendText()│
  └─────┬─────┘ └─────┬─────┘
        │             │
        └──────┬──────┘
               │
               ▼
┌─────────────────────────────┐
│ Return ParsedMessage JSON   │
└─────────────────────────────┘
```

---

## Sistema de Filas

Para garantir o processamento ordenado de mensagens por contato, o sistema implementa filas por número.

```typescript
// Estrutura de fila por contato
contactQueues: Map<string, Array<() => Promise<void>>>
contactProcessing: Map<string, boolean>

// Enfileirar processamento
enqueueMessageProcessing(task, contactNumber): void
enqueueStatusProcessing(task, contactNumber): void

// Processar fila
processContactQueue(contactNumber, type): Promise<void>
```

---

## Mensagens Automáticas

Sistema de respostas automáticas baseado em condições.

### Estrutura

```
build-automatic-messages/
├── index.ts              # Executor principal
├── conditions/           # Verificadores de condição
│   ├── index.ts
│   ├── DATE_EQUALS.ts    # Condição: data específica
│   └── OUT_TIME_RANGE.ts # Condição: fora do horário
└── response/             # Geradores de resposta
    ├── index.ts
    ├── sendText.attachment.ts
    ├── sendMedia.attachment.ts
    ├── sendContact.attachment.ts
    └── sendLocation.attachment.ts
```

### Fluxo

```
┌─────────────────┐
│ Nova Mensagem   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Load Auto Msgs  │ <- autoMessages[]
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Check Counter   │ <- send_max_times
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Check Condition │ <- checkCondition()
└────────┬────────┘
         │
    ┌────┴────┐
    │ true    │ false
    ▼         ▼
┌───────┐  ┌───────┐
│ Send  │  │ Skip  │
│ Reply │  │       │
└───────┘  └───────┘
```

---

## Tarefas Agendadas

O sistema utiliza node-cron para tarefas recorrentes:

| Tarefa | Cron Padrão | Descrição |
|--------|-------------|-----------|
| Load Avatars | `0 */4 * * *` | A cada 4 horas |
| Sync Messages | `*/2 * * * *` | A cada 2 minutos |

---

## Callbacks para Backend

O sistema envia callbacks HTTP para o backend configurado em `REQUEST_URL`.

### Eventos

| Evento | Método | Endpoint | Payload |
|--------|--------|----------|---------|
| Init | PUT | `/init/:number` | - |
| QR Code | POST | `/qr/:number` | `{ qr: string }` |
| Auth | POST | `/auth/:number` | - |
| Ready | PUT | `/ready/:number` | - |
| Message | POST | `/messages/:number` | ParsedMessage |
| Status | PUT | `/status/:number` | StatusUpdate |

### Formato REQUEST_URL

```
http://api.example.com/api/:clientName/whatsapp
```

O placeholder `:clientName` é substituído pelo nome do cliente da instância.

---

## Armazenamento de Arquivos

Arquivos de mídia são armazenados localmente.

```
FILES_DIRECTORY/
└── media/
    ├── uuid_arquivo1.jpg
    ├── uuid_arquivo2.pdf
    └── uuid_arquivo3.mp3
```

### Formato de Nome

```
{uuid}_{nome_original}.{extensão}
```

Exemplo: `a1b2c3d4-e5f6-7890-abcd-ef1234567890_documento.pdf`

---

## Tratamento de Reconexão

### Baileys

```typescript
// Tentativas de reconexão automática
reconnectAttempts: number = 0
maxReconnectAttempts: number = 10

// Eventos de conexão
connection.update: {
  connection: 'close' | 'open' | 'connecting',
  lastDisconnect: { error: Boom }
}

// Lógica de reconexão
if (shouldReconnect) {
    await this.connectToWhatsApp();
}
```

### WWEBJS

```typescript
// Eventos de estado
client.on('disconnected', (reason) => { ... })
client.on('change_state', (state) => { ... })
```

---

## Considerações de Performance

1. **Pool de Conexões MySQL**: Reutilização de conexões
2. **Filas por Contato**: Processamento ordenado sem bloqueio global
3. **Baileys Silent Logger**: Redução de logs para melhor performance
4. **Armazenamento Local**: Mensagens salvas localmente antes de sincronizar
