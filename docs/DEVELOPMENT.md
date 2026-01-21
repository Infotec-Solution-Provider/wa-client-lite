# 🚀 Guia de Desenvolvimento

Este guia fornece informações para desenvolvedores que desejam contribuir ou modificar o WA Client Lite.

## Pré-requisitos

- Node.js 18+
- npm ou yarn
- MySQL 8.0+
- Chrome/Chromium (para WWEBJS)

## Setup do Ambiente

```bash
# 1. Clonar o repositório
git clone <repository-url>
cd wa-client-lite

# 2. Instalar dependências
npm install

# 3. Copiar arquivo de configuração
cp .env.example .env

# 4. Configurar variáveis de ambiente
# Edite o arquivo .env com suas configurações

# 5. Criar banco de dados
mysql -u root -p -e "CREATE DATABASE wa_client;"
mysql -u root -p wa_client < whatsapp-client.sql

# 6. Iniciar em modo desenvolvimento
npm run start:dev
```

---

## Scripts Disponíveis

| Script | Comando | Descrição |
|--------|---------|-----------|
| `start` | `npm run start` | Executa com ts-node |
| `start:dev` | `npm run start:dev` | Executa com nodemon (hot-reload) |
| `start:prod` | `npm run start:prod` | Executa versão compilada |

---

## Estrutura de Código

### Principais Arquivos

| Arquivo | Responsabilidade |
|---------|------------------|
| `src/app.ts` | Ponto de entrada, inicializa Express |
| `src/router.ts` | Define rotas da API |
| `src/instances.ts` | Gerencia instâncias WhatsApp |
| `src/whatsapp.ts` | Implementação WWEBJS |
| `src/whatsapp-baileys.ts` | Implementação Baileys |
| `src/connection.ts` | Pool de conexão MySQL |
| `src/types.ts` | Definições TypeScript |
| `src/utils.ts` | Funções utilitárias |
| `src/log.ts` | Sistema de logging |

### Diretórios

| Diretório | Conteúdo |
|-----------|----------|
| `src/build-automatic-messages/` | Sistema de mensagens automáticas |
| `src/entities/` | Entidades de dados |
| `src/functions/` | Funções auxiliares |
| `src/resources/` | Recursos (templates HTML) |

---

## Padrões de Código

### TypeScript

- Use tipos explícitos sempre que possível
- Evite `any`, prefira tipos específicos
- Use interfaces para objetos complexos
- Documente funções públicas com JSDoc

### Async/Await

- Sempre use try/catch para operações async
- Use Promise.all para operações paralelas
- Evite callbacks aninhados

### Logging

```typescript
import { logWithDate } from "./utils";

// Use sempre com prefixo identificador
logWithDate(`[${this.clientName} - ${this.whatsappNumber}] Mensagem aqui`);
```

---

## Adicionando Nova Funcionalidade

### 1. Novo Endpoint

```typescript
// Em src/router.ts

// 1. Adicione no construtor
this.router.get("/novo-endpoint", this.novoEndpoint);

// 2. Implemente o método
async novoEndpoint(req: Request, res: Response) {
    try {
        // Lógica aqui
        return res.status(200).json({ success: true });
    } catch (err) {
        logWithDate("Erro =>", err);
        return res.status(500).json({ message: "Something went wrong" });
    }
}
```

### 2. Nova Condição de Mensagem Automática

```typescript
// Em src/build-automatic-messages/conditions/NOVA_CONDICAO.ts

function checkNOVA_CONDICAO(condition: string): boolean {
    const parsed = JSON.parse(condition);
    // Lógica de verificação
    return true;
}

export default checkNOVA_CONDICAO;
```

```typescript
// Em src/build-automatic-messages/conditions/index.ts

import checkNOVA_CONDICAO from "./NOVA_CONDICAO";

function checkCondition(condition: string): boolean {
    const { type } = JSON.parse(condition);
    
    switch (type) {
        case "NOVA_CONDICAO":
            return checkNOVA_CONDICAO(condition);
        // ...
    }
}
```

### 3. Novo Tipo de Anexo

```typescript
// Em src/build-automatic-messages/response/sendNovoTipo.attachment.ts

async function sendNovoTipo(
    automaticMessage: DBAutomaticMessage,
    instance: WhatsappInstance,
    message: WAWebJS.Message
) {
    // Lógica de envio
}

export default sendNovoTipo;
```

---

## Testando Localmente

### 1. Criar Cliente de Teste

```sql
INSERT INTO clients (name, display_name, is_active, created_at)
VALUES ('teste', 'Cliente Teste', 1, NOW());

INSERT INTO database_connections (client_name, host, port, user, password, `database`)
VALUES ('teste', 'localhost', 3306, 'root', 'senha', 'inpulse_teste');

INSERT INTO whatsapp_instances (number, client_name, type, is_active, created_at)
VALUES ('5511999999999', 'teste', 'BAILEYS', 1, NOW());
```

### 2. Testar API

```bash
# Health check
curl http://localhost:7000/whatsapp

# Status dos clientes
curl http://localhost:7000/whatsapp/clients

# Enviar mensagem
curl -X POST http://localhost:7000/whatsapp/clients/5511999999999/messages/5511888888888 \
  -H "Content-Type: application/json" \
  -d '{"text": "Teste"}'
```

---

## Debug

### Logs

Os logs são exibidos no console com timestamp:

```
[2024-01-15T10:30:00.000Z] [empresa - 5511999999999] Ready success!
```

### Verificar Estado do Cliente

```bash
curl http://localhost:7000/whatsapp/clients | jq
```

### Banco de Dados

```sql
-- Verificar mensagens pendentes
SELECT * FROM messages WHERE SYNC_MESSAGE = 0 LIMIT 10;

-- Verificar instâncias ativas
SELECT * FROM whatsapp_instances WHERE is_active = 1;
```

---

## Deploy

### Requisitos de Produção

1. **Node.js 18+** instalado
2. **MySQL 8.0+** configurado
3. **Chrome/Chromium** (se usar WWEBJS)
4. **PM2** ou similar para gerenciamento de processos

### Usando PM2

```bash
# Instalar PM2
npm install -g pm2

# Build TypeScript (se necessário)
npx tsc

# Iniciar com PM2
pm2 start dist/app.js --name wa-client-lite

# Configurar auto-start
pm2 startup
pm2 save
```

### Usando Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

EXPOSE 7000
CMD ["npm", "run", "start"]
```

---

## Troubleshooting

### Erro: Chrome não encontrado (WWEBJS)

```bash
# Linux (Ubuntu/Debian)
sudo apt-get install chromium-browser

# Configurar no .env
CHROME_BIN=/usr/bin/chromium-browser
```

### Erro: Conexão MySQL recusada

1. Verifique se o MySQL está rodando
2. Confirme as credenciais no `.env`
3. Verifique permissões do usuário

### QR Code não aparece

1. Verifique os logs do callback
2. Confirme que `REQUEST_URL` está correto
3. Verifique se o backend está recebendo os callbacks

### Mensagens não sincronizam

1. Verifique a tabela `messages`
2. Confirme que o CRON está funcionando
3. Verifique logs de erro

---

## Contribuindo

1. Fork o repositório
2. Crie uma branch: `git checkout -b feature/minha-feature`
3. Faça commits atômicos
4. Adicione testes se aplicável
5. Abra um Pull Request

### Convenção de Commits

```
feat: adiciona nova funcionalidade
fix: corrige bug
docs: atualiza documentação
refactor: refatora código sem alterar funcionalidade
test: adiciona ou modifica testes
chore: tarefas de manutenção
```
