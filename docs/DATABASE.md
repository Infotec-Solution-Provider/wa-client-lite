# 🗄 Documentação do Banco de Dados

O WA Client Lite utiliza MySQL como banco de dados. Este documento descreve a estrutura de tabelas e relacionamentos.

## Diagrama ER

```
┌─────────────────┐       ┌──────────────────────┐
│     clients     │───────│  database_connections │
│                 │  1:1  │                      │
└────────┬────────┘       └──────────────────────┘
         │ 1:N
         │
┌────────▼────────┐       ┌──────────────────────┐
│whatsapp_instances│──────│  automatic_messages  │
│                 │  1:N  │                      │
└────────┬────────┘       └──────────────────────┘
         │ 1:N
         │
┌────────▼────────┐
│ blocked_numbers │
│                 │
└─────────────────┘
```

---

## Tabelas

### clients

Cadastro de clientes do sistema.

```sql
CREATE TABLE IF NOT EXISTS `clients` (
  `name` varchar(50) NOT NULL,
  `display_name` varchar(50) DEFAULT NULL,
  `is_active` tinyint(4) NOT NULL DEFAULT '0',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `inactivated_at` timestamp NULL DEFAULT NULL,
  UNIQUE KEY `PK_CUSTMER_NAME` (`name`)
);
```

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `name` | varchar(50) | **PK** - Nome único do cliente (slug) |
| `display_name` | varchar(50) | Nome de exibição |
| `is_active` | tinyint | Se o cliente está ativo (0/1) |
| `created_at` | timestamp | Data de criação |
| `updated_at` | timestamp | Data de atualização |
| `inactivated_at` | timestamp | Data de inativação |

---

### database_connections

Conexões de banco de dados de cada cliente.

```sql
CREATE TABLE IF NOT EXISTS `database_connections` (
  `client_name` varchar(50) NOT NULL,
  `host` varchar(12) NOT NULL DEFAULT '',
  `port` int(11) NOT NULL DEFAULT '3306',
  `user` text NOT NULL,
  `password` text NOT NULL,
  `database` varchar(50) NOT NULL DEFAULT '',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`client_name`),
  UNIQUE KEY `IDX_UNIQUE_DATABASE` (`host`,`database`,`port`),
  CONSTRAINT `FK_CONNECTION_CLIENT_NAME` FOREIGN KEY (`client_name`) 
    REFERENCES `clients` (`name`) ON DELETE NO ACTION ON UPDATE NO ACTION
);
```

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `client_name` | varchar(50) | **PK/FK** - Nome do cliente |
| `host` | varchar(12) | Host do banco de dados |
| `port` | int | Porta (padrão: 3306) |
| `user` | text | Usuário do banco |
| `password` | text | Senha do banco (criptografada) |
| `database` | varchar(50) | Nome do banco de dados |
| `created_at` | timestamp | Data de criação |
| `updated_at` | timestamp | Data de atualização |

---

### whatsapp_instances

Instâncias de WhatsApp configuradas.

```sql
CREATE TABLE IF NOT EXISTS `whatsapp_instances` (
  `number` varchar(13) NOT NULL,
  `client_name` varchar(50) NOT NULL,
  `type` enum('WWEBJS','BAILEYS') NOT NULL DEFAULT 'WWEBJS',
  `is_active` tinyint(4) NOT NULL DEFAULT '1',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `inactivated_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`number`),
  KEY `FK_INSTANCE_CLIENT` (`client_name`),
  CONSTRAINT `FK_INSTANCE_CLIENT` FOREIGN KEY (`client_name`) 
    REFERENCES `clients` (`name`) ON DELETE NO ACTION ON UPDATE NO ACTION
);
```

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `number` | varchar(13) | **PK** - Número do WhatsApp |
| `client_name` | varchar(50) | **FK** - Nome do cliente |
| `type` | enum | Tipo de implementação (WWEBJS/BAILEYS) |
| `is_active` | tinyint | Se a instância está ativa |
| `created_at` | timestamp | Data de criação |
| `updated_at` | timestamp | Data de atualização |
| `inactivated_at` | timestamp | Data de inativação |

#### Tipos de Instância

| Tipo | Descrição |
|------|-----------|
| `WWEBJS` | whatsapp-web.js (Puppeteer) |
| `BAILEYS` | @whiskeysockets/baileys (WebSocket) |

---

### automatic_messages

Mensagens automáticas configuradas por instância.

```sql
CREATE TABLE IF NOT EXISTS `automatic_messages` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `instance_number` varchar(13) NOT NULL,
  `text` text,
  `attachment` varchar(255) DEFAULT NULL,
  `attachment_type` enum('contact','document','image','video','audio','voice','location') DEFAULT NULL,
  `send_condition` text NOT NULL,
  `send_max_times` int(11) NOT NULL DEFAULT '1',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `FK_AUTO_MESSAGE_INSTANCE_NUMBER` (`instance_number`),
  CONSTRAINT `FK_AUTO_MESSAGE_INSTANCE_NUMBER` FOREIGN KEY (`instance_number`) 
    REFERENCES `whatsapp_instances` (`number`) ON DELETE NO ACTION ON UPDATE NO ACTION
);
```

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | int | **PK** - ID auto-incremento |
| `instance_number` | varchar(13) | **FK** - Número da instância |
| `text` | text | Texto da mensagem |
| `attachment` | varchar(255) | Nome do arquivo de anexo |
| `attachment_type` | enum | Tipo do anexo |
| `send_condition` | text | Condição de envio (JSON) |
| `send_max_times` | int | Máximo de envios por contato |
| `is_active` | tinyint | Se está ativa |
| `created_at` | timestamp | Data de criação |
| `updated_at` | timestamp | Data de atualização |

#### Tipos de Anexo

| Tipo | Descrição |
|------|-----------|
| `contact` | Cartão de contato |
| `document` | Documento (PDF, DOC, etc) |
| `image` | Imagem |
| `video` | Vídeo |
| `audio` | Arquivo de áudio |
| `voice` | Mensagem de voz (PTT) |
| `location` | Localização |

#### Condições de Envio

As condições são definidas em JSON e suportam:

- `DATE_EQUALS` - Data específica
- `OUT_TIME_RANGE` - Fora do horário de atendimento

Exemplo:
```json
{
  "type": "OUT_TIME_RANGE",
  "start": "08:00",
  "end": "18:00"
}
```

---

### blocked_numbers

Números bloqueados por instância.

```sql
CREATE TABLE IF NOT EXISTS `blocked_numbers` (
  `instance_number` varchar(13) NOT NULL DEFAULT '',
  `blocked_number` varchar(13) NOT NULL DEFAULT '',
  `blocked_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `IDX_UNIQUE_INSTANCE_BLOCKED_NUMBER` (`instance_number`,`blocked_number`),
  CONSTRAINT `FK_BLOCKED_INSTANCE_NUMBER` FOREIGN KEY (`instance_number`) 
    REFERENCES `whatsapp_instances` (`number`) ON DELETE NO ACTION ON UPDATE NO ACTION
);
```

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `instance_number` | varchar(13) | **FK** - Número da instância |
| `blocked_number` | varchar(13) | Número bloqueado |
| `blocked_at` | timestamp | Data do bloqueio |

---

### messages

Armazenamento local de mensagens para sincronização.

```sql
CREATE TABLE IF NOT EXISTS `messages` (
  `ID` varchar(100) NOT NULL,
  `MENSAGEM` text,
  `ID_REFERENCIA` varchar(100) DEFAULT NULL,
  `TIPO` varchar(50) DEFAULT NULL,
  `TIMESTAMP` bigint(20) DEFAULT NULL,
  `FROM_ME` tinyint(1) NOT NULL DEFAULT '0',
  `DATA_HORA` datetime DEFAULT NULL,
  `STATUS` varchar(20) DEFAULT NULL,
  `ARQUIVO_TIPO` varchar(100) DEFAULT NULL,
  `ARQUIVO_NOME_ORIGINAL` varchar(255) DEFAULT NULL,
  `ARQUIVO_NOME` varchar(255) DEFAULT NULL,
  `ARQUIVO_ARMAZENAMENTO` varchar(50) DEFAULT NULL,
  `SYNC_MESSAGE` tinyint(1) NOT NULL DEFAULT '0',
  `SYNC_STATUS` tinyint(1) NOT NULL DEFAULT '0',
  `INSTANCE` varchar(100) NOT NULL,
  `FROM` varchar(20) NOT NULL,
  PRIMARY KEY (`ID`),
  KEY `idx_instance` (`INSTANCE`),
  KEY `idx_sync` (`SYNC_MESSAGE`,`SYNC_STATUS`),
  KEY `idx_from` (`FROM`)
);
```

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `ID` | varchar(100) | **PK** - ID da mensagem |
| `MENSAGEM` | text | Conteúdo da mensagem |
| `ID_REFERENCIA` | varchar(100) | ID da mensagem referenciada |
| `TIPO` | varchar(50) | Tipo da mensagem |
| `TIMESTAMP` | bigint | Timestamp em milissegundos |
| `FROM_ME` | tinyint | Se enviada pelo sistema |
| `DATA_HORA` | datetime | Data/hora da mensagem |
| `STATUS` | varchar(20) | Status (PENDING, SENT, etc) |
| `ARQUIVO_TIPO` | varchar(100) | MIME type do arquivo |
| `ARQUIVO_NOME_ORIGINAL` | varchar(255) | Nome original do arquivo |
| `ARQUIVO_NOME` | varchar(255) | Nome salvo do arquivo |
| `ARQUIVO_ARMAZENAMENTO` | varchar(50) | Local de armazenamento |
| `SYNC_MESSAGE` | tinyint | Se mensagem foi sincronizada |
| `SYNC_STATUS` | tinyint | Se status foi sincronizado |
| `INSTANCE` | varchar(100) | Número da instância |
| `FROM` | varchar(20) | Número do remetente |

#### Status de Mensagem

| Status | Descrição |
|--------|-----------|
| `PENDING` | Pendente |
| `SENT` | Enviada |
| `RECEIVED` | Recebida pelo servidor |
| `READ` | Lida |
| `PLAYED` | Reproduzida (áudio/vídeo) |
| `ERROR` | Erro no envio |

---

### raw_messages

Armazenamento de mensagens brutas para debug.

```sql
CREATE TABLE IF NOT EXISTS `raw_messages` (
  `ID` varchar(100) NOT NULL,
  `SOURCE` ENUM('WWEBJS','BAILEYS') NOT NULL,
  `RAW_DATA` longtext,
  `CREATED_AT` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`)
);
```

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `ID` | varchar(100) | **PK** - ID da mensagem |
| `SOURCE` | enum | Fonte (WWEBJS/BAILEYS) |
| `RAW_DATA` | longtext | Dados JSON brutos |
| `CREATED_AT` | timestamp | Data de criação |

---

## Índices

### Índices de Performance

| Tabela | Índice | Colunas |
|--------|--------|---------|
| messages | idx_instance | INSTANCE |
| messages | idx_sync | SYNC_MESSAGE, SYNC_STATUS |
| messages | idx_from | FROM |

### Índices Únicos

| Tabela | Índice | Colunas |
|--------|--------|---------|
| clients | PK_CUSTMER_NAME | name |
| database_connections | IDX_UNIQUE_DATABASE | host, database, port |
| blocked_numbers | IDX_UNIQUE_INSTANCE_BLOCKED_NUMBER | instance_number, blocked_number |

---

## Script de Criação

O script completo está disponível em `whatsapp-client.sql`.

```bash
# Executar script de criação
mysql -u root -p < whatsapp-client.sql
```

---

## Exemplos de Consultas

### Listar instâncias ativas com conexão

```sql
SELECT 
    wi.*,
    db.host AS db_host,
    db.port AS db_port,
    db.user AS db_user,
    db.database AS db_name
FROM whatsapp_instances wi
LEFT JOIN clients c ON c.name = wi.client_name
LEFT JOIN database_connections db ON db.client_name = wi.client_name
WHERE c.is_active AND wi.is_active;
```

### Buscar mensagens não sincronizadas

```sql
SELECT * FROM messages 
WHERE SYNC_MESSAGE = 0 OR SYNC_STATUS = 0
ORDER BY DATA_HORA ASC;
```

### Contar mensagens por instância

```sql
SELECT INSTANCE, COUNT(*) as total
FROM messages
GROUP BY INSTANCE;
```

### Listar mensagens automáticas ativas

```sql
SELECT * FROM automatic_messages
WHERE is_active = 1
ORDER BY instance_number, id;
```
