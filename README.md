# Bot de Vendas Automatizado para Discord

Um bot Discord avançado para automação de vendas com integração PIX/EFI Pay e suporte a criptomoedas, desenvolvido especificamente para comunidades brasileiras.

## Principais Funcionalidades

### Sistema de Vendas
- **Produtos configuráveis**: Gerenciamento completo de produtos com subprodutos e preços variados
- **Sistema de estoque**: Controle automático de estoque com distribuição de produtos digitais
- **Carrinho de compras**: Interface intuitiva para seleção de múltiplos produtos
- **Cupons de desconto**: Sistema de cupons globais e específicos
- **Histórico de transações**: Registro completo de todas as vendas realizadas

### Métodos de Pagamento
- **PIX**: Integração oficial com EFI Pay (Gerencianet) para pagamentos instantâneos
- **Criptomoedas**: Suporte a Bitcoin, Litecoin e outras moedas digitais
- **Pagamentos personalizados**: Sistema flexível para métodos alternativos
- **Verificação automática**: Monitoramento em tempo real do status dos pagamentos

### Sistema de Tickets
- **Suporte automatizado**: Criação automática de tickets para atendimento
- **Categorização**: Organização por tipos de solicitação
- **Logs completos**: Registro de todas as interações e transações

### Sistema de Revendedores
- **Programa de afiliados**: Cadastro e gerenciamento de revendedores
- **Descontos especiais**: Sistema de desconto automático para revendedores (50%)
- **Controle de saldo**: Gerenciamento de comissões e retiradas
- **Dashboard personalizado**: Interface específica para revendedores

### Sistema de Sorteios
- **Sorteios automatizados**: Criação e gerenciamento de giveaways
- **Participação por reação**: Sistema simples de participação
- **Múltiplos ganhadores**: Suporte a sorteios com vários premiados
- **Histórico completo**: Registro de todos os sorteios realizados

### Analytics e Relatórios
- **Dashboard de vendas**: Estatísticas detalhadas de performance
- **Análise de produtos**: Produtos mais vendidos e rentabilidade
- **Relatórios financeiros**: Controle completo de receitas e comissões
- **Métricas de usuários**: Dados sobre engajamento e conversão

## Tecnologias Utilizadas

- **Discord.js v14**: Biblioteca principal para interação com a API do Discord
- **SDK EFI Pay**: Integração oficial com a API da Gerencianet
- **QRCode**: Geração de códigos QR para pagamentos PIX
- **Sharp**: Processamento de imagens
- **Node.js**: Runtime JavaScript para o servidor

## Estrutura do Projeto

```
Bot-de-Vendas-Automatizado-para-Discord/
├── data/                          # Dados da aplicação
│   ├── analytics.json             # Dados de analytics
│   ├── balance_transactions.json  # Transações de saldo
│   ├── balances.json             # Saldos dos usuários
│   ├── custom_payments.json      # Pagamentos personalizados
│   ├── giveaways.json           # Dados dos sorteios
│   ├── global_discount.json     # Cupons de desconto
│   ├── products.json            # Catálogo de produtos
│   ├── resellers.json           # Dados dos revendedores
│   ├── stock.json               # Controle de estoque
│   ├── tickets.json             # Sistema de tickets
│   └── transactions.json        # Histórico de transações
├── assets/                      # Recursos visuais
│   └── logo.png                # Logo do projeto
├── backups/                     # Backups automáticos
├── temp/                        # Arquivos temporários
├── config.json                  # Configurações do bot
├── index.js                     # Arquivo principal
├── package.json                 # Dependências do projeto
└── certificado.p12             # Certificado EFI Pay
```

## Instalação

### Pré-requisitos
- Node.js (versão 16.0.0 ou superior)
- Conta no Discord Developer Portal
- Conta na EFI Pay (Gerencianet) com certificado
- Servidor Discord com permissões de administrador

### Passos de Instalação

1. **Clone o repositório**
```bash
git clone <url-do-repositorio>
cd Bot-de-Vendas-Automatizado-para-Discord
```

2. **Instale as dependências**
```bash
npm install
```

3. **Configure as variáveis de ambiente**
Crie um arquivo `.env` na raiz do projeto:
```env
DISCORD_TOKEN=seu_token_discord
EFI_CLIENT_ID=seu_client_id_efi
EFI_CLIENT_SECRET=seu_client_secret_efi
TICKET_CATEGORY_ID=id_categoria_tickets
LOG_CHANNEL_ID=id_canal_logs
```

4. **Configure o certificado EFI Pay**
- Baixe seu certificado `.p12` da EFI Pay
- Coloque o arquivo como `certificado.p12` na raiz do projeto

5. **Configure o bot**
- Edite o arquivo `config.json` com suas configurações específicas
- Configure os IDs dos canais e categorias necessários

6. **Execute o bot**
```bash
npm start
```

Para desenvolvimento:
```bash
npm run dev
```

## Configuração

### Discord
- Configure as permissões necessárias para o bot
- Crie as categorias e canais conforme especificado no config
- Configure os cargos de cliente e revendedor

### EFI Pay
- Obtenha suas credenciais na conta EFI Pay
- Baixe o certificado de produção
- Configure os webhooks para notificações automáticas

### Produtos
- Adicione produtos através dos comandos do bot
- Configure estoque e preços adequadamente
- Teste o fluxo completo de compra

## Comandos Principais

### Comandos de Administração
- `/painel-admin` - Painel principal de administração
- `/adicionar-produto` - Adicionar novo produto
- `/gerenciar-estoque` - Controle de estoque
- `/cupom-global` - Criar cupons de desconto
- `/analytics` - Visualizar relatórios

### Comandos de Vendas
- `/loja` - Abrir catálogo de produtos
- `/meu-carrinho` - Visualizar carrinho atual
- `/finalizar-compra` - Processar pagamento
- `/status-pagamento` - Verificar status do pagamento

### Comandos de Revendedor
- `/painel-revendedor` - Dashboard do revendedor
- `/solicitar-saque` - Solicitar retirada de comissões
- `/minhas-vendas` - Histórico de vendas

### Comandos de Sorteio
- `/criar-sorteio` - Criar novo sorteio
- `/participar-sorteio` - Participar de sorteio ativo
- `/finalizar-sorteio` - Encerrar e sortear ganhadores

## Segurança

- Tokens e credenciais armazenados em variáveis de ambiente
- Validação rigorosa de todas as entradas
- Sistema de cooldown para prevenir spam
- Logs detalhados de todas as operações
- Backups automáticos dos dados

## Monitoramento

O bot inclui sistema completo de logs e analytics:
- Logs de transações em tempo real
- Métricas de performance de vendas
- Alertas para erros e problemas
- Dashboard de analytics integrado

## Contribuição

Este é um projeto de código fechado. Para questões e suporte, entre em contato através dos canais oficiais.

## Licença

Este projeto está licenciado sob a licença ISC. Veja o arquivo LICENSE para mais detalhes.

## Suporte

Para suporte técnico ou dúvidas sobre implementação:
- Abra um ticket no servidor Discord
- Consulte a documentação técnica
- Entre em contato através dos canais oficiais

---

**Desenvolvido para comunidades Discord brasileiras com foco em automação de vendas e gestão financeira integrada.**