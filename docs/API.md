# 📡 Documentação da API

O WA Client Lite expõe uma API REST na porta **7000** com o prefixo `/whatsapp`.

## Base URL

```
http://localhost:7000/whatsapp
```

---

## Endpoints

### Health Check

Verifica se o serviço está online.

```http
GET /whatsapp
```

#### Resposta de Sucesso (200)

```json
{
  "online": true
}
```

---

### Status dos Clientes

Retorna o status de todas as instâncias WhatsApp.

```http
GET /whatsapp/clients
```

#### Resposta de Sucesso (200)

```json
{
  "instances": [
    {
      "client": "empresa_abc",
      "number": "5511999999999",
      "auth": true,
      "ready": true,
      "status": "CONNECTED"
    }
  ]
}
```

#### Campos da Resposta

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `client` | string | Nome do cliente |
| `number` | string | Número do WhatsApp |
| `auth` | boolean | Se está autenticado |
| `ready` | boolean | Se está pronto para uso |
| `status` | string | Estado da conexão |

Aceita `?client=<nome>` para listar só as instâncias de um cliente. Instâncias Baileys e ZAPO trazem também os campos de [Status da Sessão](#status-da-sessão).

---

### Status da Sessão

Retorna o estado da sessão de uma instância Baileys ou ZAPO. Instâncias WWEBJS respondem 400.

```http
GET /whatsapp/clients/:from/session
```

#### Resposta de Sucesso (200)

```json
{
  "client": "empresa_abc",
  "number": "5511999999999",
  "type": "BAILEYS",
  "auth": true,
  "ready": true,
  "state": "CONNECTED",
  "action": null,
  "phone": "5511999999999",
  "pushName": "Empresa ABC",
  "qr": null,
  "qrAt": null,
  "startedAt": "2026-10-01T11:00:00.000Z",
  "connectedAt": "2026-10-01T11:00:12.000Z",
  "stateChangedAt": "2026-10-01T11:00:12.000Z",
  "lastDisconnectReason": null,
  "lastReceivedAt": "2026-10-01T13:42:05.000Z",
  "lastSentAt": "2026-10-01T13:40:51.000Z"
}
```

#### Campos da Resposta

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `state` | string | `STARTING`, `QR_PENDING`, `CONNECTED` ou `DISCONNECTED` |
| `action` | string \| null | `RESTART` ou `LOGOUT` enquanto uma ação está em andamento |
| `phone` | string \| null | Número pareado de fato (pode diferir de `number`, que é o identificador da instância) |
| `pushName` | string \| null | Nome do perfil no WhatsApp |
| `qr` / `qrAt` | string \| null | QR code atual e quando foi gerado, enquanto `state` é `QR_PENDING` |
| `startedAt` | string | Quando o serviço criou a instância |
| `connectedAt` | string \| null | Início da conexão atual (base do tempo de sessão) |
| `stateChangedAt` | string | Última mudança de `state` |
| `lastDisconnectReason` | string \| null | Motivo da última desconexão |
| `lastReceivedAt` | string \| null | Última mensagem recebida (carregada da tabela `messages` ao iniciar) |
| `lastSentAt` | string \| null | Última mensagem enviada desde que o serviço iniciou |

---

### Reiniciar Sessão

Fecha a conexão e reconecta com as credenciais salvas, sem novo QR code.

```http
POST /whatsapp/clients/:from/restart
```

Responde 200 com o [Status da Sessão](#status-da-sessão) logo após iniciar a reconexão.

---

### Desvincular Número

Remove o aparelho da lista de dispositivos conectados do celular, apaga as credenciais e inicia um novo pareamento. O QR code segue pelo callback `POST {REQUEST_URL}/qr/:number`.

```http
POST /whatsapp/clients/:from/logout
```

Responde 200 com o [Status da Sessão](#status-da-sessão).

#### Respostas de Erro (restart e logout)

| Código | Descrição |
|--------|-----------|
| 400 | Instância WWEBJS (não suportada) |
| 404 | Instância não encontrada |
| 409 | Outra ação já está em andamento na instância |
| 500 | Falha ao executar a ação |

---

### Obter Foto de Perfil

Retorna a URL da foto de perfil de um contato.

```http
GET /whatsapp/clients/:from/avatars/:to
```

#### Parâmetros de URL

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `from` | string | Número da instância WhatsApp |
| `to` | string | Número do contato |

#### Resposta de Sucesso (200)

```json
{
  "url": "https://pps.whatsapp.net/..."
}
```

#### Respostas de Erro

| Código | Descrição |
|--------|-----------|
| 400 | Parâmetros obrigatórios ausentes |
| 404 | Instância não encontrada |
| 500 | Erro interno |

---

### Carregar Mensagens

Inicia o carregamento de mensagens históricas.

```http
GET /whatsapp/clients/:from/load-messages
```

#### Parâmetros de URL

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `from` | string | Número da instância WhatsApp |

#### Resposta de Sucesso (200)

```json
{
  "loaded": 150,
  "errors": 2
}
```

---

### Carregar Avatares

Inicia o carregamento de avatares de contatos.

```http
GET /whatsapp/clients/:from/load-avatars
```

#### Parâmetros de URL

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `from` | string | Número da instância WhatsApp |

#### Resposta de Sucesso (200)

```json
{
  "loaded": 50,
  "failed": 5
}
```

---

### Carregar Contatos

Inicia o carregamento de contatos do WhatsApp.

```http
GET /whatsapp/clients/:from/load-contacts
```

#### Parâmetros de URL

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `from` | string | Número da instância WhatsApp |

#### Resposta de Sucesso (200)

```json
{
  "message": "Load contacts started"
}
```

#### Resposta de Conflito (409)

```json
{
  "message": "Load contacts is already running for this instance"
}
```

---

### Validar Número

Verifica se um número é válido no WhatsApp.

```http
GET /whatsapp/clients/:from/validate-number/:to
```

#### Parâmetros de URL

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `from` | string | Número da instância WhatsApp |
| `to` | string | Número a ser validado |

#### Resposta de Sucesso (200)

```json
{
  "validNumber": "5511999999999@c.us"
}
```

---

### Obter Arquivo

Retorna um arquivo de mídia previamente salvo.

```http
GET /whatsapp/files/:filename
```

#### Parâmetros de URL

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `filename` | string | Nome do arquivo |

#### Resposta de Sucesso (200)

Retorna o arquivo binário com os headers apropriados:
- `Content-Type`: Tipo MIME do arquivo
- `Content-Disposition`: `inline; filename="nome_original.ext"`

#### Respostas de Erro

| Código | Descrição |
|--------|-----------|
| 400 | Filename é obrigatório |
| 404 | Arquivo não encontrado |
| 500 | Erro interno |

---

### Upload de Arquivo

Faz upload de um arquivo para uso posterior.

```http
POST /whatsapp/files
```

#### Headers

```
Content-Type: multipart/form-data
```

#### Body (Form Data)

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `file` | File | Arquivo a ser enviado |

#### Resposta de Sucesso (201)

```json
{
  "filename": "uuid_nome_original.ext"
}
```

---

### Enviar Mensagem

Envia uma mensagem de texto ou arquivo.

```http
POST /whatsapp/clients/:from/messages/:to
```

#### Parâmetros de URL

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `from` | string | Número da instância WhatsApp |
| `to` | string | Número do destinatário |

#### Headers

```
Content-Type: multipart/form-data
```

ou

```
Content-Type: application/json
```

#### Body (JSON - Mensagem de Texto)

```json
{
  "text": "Olá, mundo!",
  "referenceId": "id_mensagem_para_responder"
}
```

#### Body (Form Data - Com Arquivo)

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `text` | string | Texto/legenda (opcional) |
| `file` | File | Arquivo a ser enviado |
| `referenceId` | string | ID da mensagem para responder (opcional) |
| `isAudio` | string | "true" para enviar como áudio de voz |

#### Body (JSON - Com Arquivo Existente)

```json
{
  "text": "Veja este documento",
  "filename": "uuid_documento.pdf"
}
```

#### Resposta de Sucesso (201)

```json
{
  "ID": "true_5511999999999@c.us_ABC123",
  "TIPO": "chat",
  "MENSAGEM": "Olá, mundo!",
  "TIMESTAMP": 1642000000000,
  "FROM_ME": true,
  "DATA_HORA": "2022-01-12T12:00:00.000Z",
  "STATUS": "SENT",
  "ARQUIVO": null
}
```

#### Resposta com Arquivo (201)

```json
{
  "ID": "true_5511999999999@c.us_ABC123",
  "TIPO": "image",
  "MENSAGEM": "Legenda da imagem",
  "TIMESTAMP": 1642000000000,
  "FROM_ME": true,
  "DATA_HORA": "2022-01-12T12:00:00.000Z",
  "STATUS": "SENT",
  "ARQUIVO": {
    "NOME_ARQUIVO": "uuid_imagem.jpg",
    "TIPO": "image/jpeg",
    "NOME_ORIGINAL": "imagem.jpg",
    "ARMAZENAMENTO": "outros"
  }
}
```

#### Respostas de Erro

| Código | Descrição |
|--------|-----------|
| 400 | Parâmetros obrigatórios ausentes |
| 404 | Instância não encontrada |
| 500 | Erro ao enviar mensagem |

---

## Formatos de Número

Os números de telefone devem seguir o padrão internacional sem o sinal de `+`:

```
5511999999999
```

Onde:
- `55` = Código do país (Brasil)
- `11` = DDD
- `999999999` = Número do telefone

---

## Códigos de Status HTTP

| Código | Descrição |
|--------|-----------|
| 200 | Sucesso |
| 201 | Criado com sucesso |
| 400 | Requisição inválida |
| 404 | Recurso não encontrado |
| 409 | Conflito (processo já em execução) |
| 500 | Erro interno do servidor |

---

## Tipos de Mídia Suportados

| Tipo | Extensões |
|------|-----------|
| Imagem | jpg, jpeg, png, gif, webp |
| Documento | pdf, doc, docx, xls, xlsx, ppt, pptx, txt |
| Áudio | mp3, ogg, opus, m4a, wav |
| Vídeo | mp4, avi, mkv, mov, webm |

---

## Webhooks (Callbacks)

O WA Client Lite envia callbacks para o backend configurado em `REQUEST_URL`:

### Eventos Enviados

| Endpoint | Método | Evento |
|----------|--------|--------|
| `/init/:number` | PUT | Inicialização da instância |
| `/qr/:number` | POST | QR Code gerado |
| `/auth/:number` | POST | Autenticação bem-sucedida |
| `/ready/:number` | PUT | Instância pronta |
| `/messages/:number` | POST | Nova mensagem recebida |
| `/status/:number` | PUT | Atualização de status de mensagem |

### Exemplo de Payload de Mensagem

```json
{
  "ID": "false_5511999999999@c.us_ABC123",
  "ID_REFERENCIA": null,
  "TIPO": "chat",
  "MENSAGEM": "Olá!",
  "TIMESTAMP": 1642000000000,
  "FROM_ME": false,
  "DATA_HORA": "2022-01-12T12:00:00.000Z",
  "STATUS": "RECEIVED",
  "ARQUIVO": null,
  "CONTATO_NUMERO": "5511999999999"
}
```
