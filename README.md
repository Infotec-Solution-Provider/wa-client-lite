# WA Client Lite

Cliente WhatsApp leve para integração com sistemas backend. Suporta duas implementações: **whatsapp-web.js** (WWEBJS) e **Baileys**.

## 📋 Índice

- [Sobre o Projeto](#sobre-o-projeto)
- [Tecnologias](#tecnologias)
- [Arquitetura](#arquitetura)
- [Instalação](#instalação)
- [Configuração](#configuração)
- [Execução](#execução)
- [API](#api)
- [Banco de Dados](#banco-de-dados)
- [Estrutura do Projeto](#estrutura-do-projeto)

## 📖 Sobre o Projeto

O **WA Client Lite** é um serviço que gerencia múltiplas instâncias de WhatsApp simultaneamente, permitindo:

- Envio e recebimento de mensagens
- Envio de arquivos (imagens, documentos, áudios, vídeos)
- Mensagens automáticas configuráveis
- Sincronização de mensagens com servidor backend
- Carregamento de avatares e contatos
- Suporte a múltiplos clientes com bancos de dados separados

## 🛠 Tecnologias

| Tecnologia | Versão | Descrição |
|------------|--------|-----------|
| Node.js | 18+ | Runtime JavaScript |
| TypeScript | 5.9+ | Superset JavaScript tipado |
| Express | 4.21+ | Framework web |
| MySQL | 8.0+ | Banco de dados relacional |
| whatsapp-web.js | 1.34+ | Biblioteca WhatsApp (Puppeteer) |
| @whiskeysockets/baileys | 6.7+ | Biblioteca WhatsApp (WebSocket) |
| mysql-baileys | 1.5+ | Armazenamento de sessão Baileys |
| node-cron | 3.0+ | Agendamento de tarefas |

## 🏗 Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                        WA Client Lite                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐      │
│  │   Express   │────│   Router    │────│  Instances  │      │
│  │   (7000)    │    │             │    │   Manager   │      │
│  └─────────────┘    └─────────────┘    └──────┬──────┘      │
│                                                │              │
│                    ┌───────────────────────────┼────────────┐│
│                    │                           │            ││
│            ┌───────▼──────┐           ┌────────▼───────┐    ││
│            │   WWEBJS     │           │    Baileys     │    ││
│            │  (Puppeteer) │           │   (WebSocket)  │    ││
│            └───────┬──────┘           └────────┬───────┘    ││
│                    │                           │             │
│                    └───────────┬───────────────┘             │
│                                │                             │
│                    ┌───────────▼───────────┐                 │
│                    │   WhatsApp Servers    │                 │
│                    └───────────────────────┘                 │
└─────────────────────────────────────────────────────────────┘
                                │
           ┌────────────────────┼────────────────────┐
           │                    │                    │
   ┌───────▼───────┐   ┌───────▼───────┐   ┌───────▼───────┐
   │ wa-client DB  │   │   Client 1    │   │   Client N    │
   │  (principal)  │   │      DB       │   │      DB       │
   └───────────────┘   └───────────────┘   └───────────────┘
```

## 📦 Instalação

```bash
# Clonar o repositório
git clone <repository-url>
cd wa-client-lite

# Instalar dependências
npm install

# Configurar variáveis de ambiente
cp .env.example .env

# Criar estrutura do banco de dados
mysql -u root -p < whatsapp-client.sql
```

## ⚙️ Configuração

### Variáveis de Ambiente

Crie um arquivo `.env` na raiz do projeto:

```env
# Banco de dados principal (wa-client)
DATABASE_HOST=localhost
DATABASE_USER=root
DATABASE_PASSWORD=sua_senha
DATABASE_DATABASE=wa_client

# URL de callback para o backend
REQUEST_URL=http://sua-api.com/api/:clientName/wwebjs

# Diretório para armazenamento de arquivos
FILES_DIRECTORY=/path/to/files

# Agendamentos (opcional - formato CRON)
CRON_LOAD_AVATARS=0 */4 * * *
CRON_SYNC_MESSAGES=*/2 * * * *

# Chrome (para WWEBJS - opcional)
CHROME_BIN=/usr/bin/chromium-browser
# OU
CHROME_WS=ws://localhost:3000

# Outras configurações
USE_LOCAL_DATE=true
```

### Variáveis de Ambiente Detalhadas

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `DATABASE_HOST` | ✅ | Host do banco de dados principal |
| `DATABASE_USER` | ✅ | Usuário do banco de dados |
| `DATABASE_PASSWORD` | ✅ | Senha do banco de dados |
| `DATABASE_DATABASE` | ✅ | Nome do banco de dados principal |
| `REQUEST_URL` | ✅ | URL do backend (use `:clientName` como placeholder) |
| `FILES_DIRECTORY` | ✅ | Diretório para arquivos de mídia |
| `CRON_LOAD_AVATARS` | ❌ | Cron para carregar avatares (padrão: `0 */4 * * *`) |
| `CRON_SYNC_MESSAGES` | ❌ | Cron para sincronizar mensagens (padrão: `*/2 * * * *`) |
| `CHROME_BIN` | ❌ | Caminho do executável Chrome (WWEBJS) |
| `CHROME_WS` | ❌ | WebSocket do Chrome remoto (WWEBJS) |
| `USE_LOCAL_DATE` | ❌ | Usar data local ao invés do timestamp da mensagem |

## 🚀 Execução

```bash
# Desenvolvimento (com hot-reload)
npm run start:dev

# Desenvolvimento (sem hot-reload)
npm run start

# Produção (requer build prévio)
npm run start:prod
```

O servidor será iniciado na porta **7000**.

## 📡 API

A documentação completa da API está disponível em [docs/API.md](docs/API.md).

### Resumo dos Endpoints

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/whatsapp` | Health check |
| GET | `/whatsapp/clients` | Status de todos os clientes |
| GET | `/whatsapp/clients/:from/avatars/:to` | Obter foto de perfil |
| GET | `/whatsapp/clients/:from/load-messages` | Carregar mensagens |
| GET | `/whatsapp/clients/:from/load-avatars` | Carregar avatares |
| GET | `/whatsapp/clients/:from/load-contacts` | Carregar contatos |
| GET | `/whatsapp/clients/:from/validate-number/:to` | Validar número |
| GET | `/whatsapp/files/:filename` | Obter arquivo |
| POST | `/whatsapp/files` | Upload de arquivo |
| POST | `/whatsapp/clients/:from/messages/:to` | Enviar mensagem |

## 🗄 Banco de Dados

Para mais detalhes sobre a estrutura do banco de dados, consulte [docs/DATABASE.md](docs/DATABASE.md).

### Tabelas Principais

- **clients** - Cadastro de clientes
- **database_connections** - Conexões de banco de dados por cliente
- **whatsapp_instances** - Instâncias de WhatsApp
- **automatic_messages** - Mensagens automáticas
- **blocked_numbers** - Números bloqueados
- **messages** - Mensagens para sincronização
- **raw_messages** - Mensagens brutas para debug

## 📁 Estrutura do Projeto

```
wa-client-lite/
├── src/
│   ├── app.ts                    # Ponto de entrada
│   ├── router.ts                 # Rotas da API
│   ├── connection.ts             # Pool de conexão MySQL
│   ├── instances.ts              # Gerenciador de instâncias
│   ├── whatsapp.ts               # Implementação WWEBJS
│   ├── whatsapp-baileys.ts       # Implementação Baileys
│   ├── types.ts                  # Tipos TypeScript
│   ├── utils.ts                  # Funções utilitárias
│   ├── log.ts                    # Sistema de logs
│   ├── build-automatic-messages/ # Sistema de mensagens automáticas
│   │   ├── index.ts
│   │   ├── conditions/           # Condições para envio
│   │   └── response/             # Tipos de resposta
│   ├── entities/                 # Entidades de dados
│   ├── functions/                # Funções auxiliares
│   └── resources/                # Recursos (templates)
├── docs/                         # Documentação
├── package.json
├── tsconfig.json
├── whatsapp-client.sql           # Script de criação do banco
└── README.md
```

## 📞 Tipos de Instância

### WWEBJS (whatsapp-web.js)

- Utiliza Puppeteer para simular o WhatsApp Web
- Requer Chrome/Chromium instalado
- Mais compatível com recursos avançados

### Baileys

- Conexão direta via WebSocket
- Menor consumo de recursos
- Mais rápido e leve
- Suporta armazenamento de sessão em MySQL

## 📄 Licença

ISC

## 🤝 Contribuição

1. Faça um fork do projeto
2. Crie uma branch para sua feature (`git checkout -b feature/nova-feature`)
3. Commit suas alterações (`git commit -m 'Adiciona nova feature'`)
4. Push para a branch (`git push origin feature/nova-feature`)
5. Abra um Pull Request
