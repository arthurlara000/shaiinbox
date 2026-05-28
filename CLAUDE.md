# CLAUDE.md — Shai Inbox

Contexto completo do projeto para o Claude Code.

---

## 🏪 SOBRE O PROJETO

**Shai Inbox** é um painel de atendimento e vendas centralizado para a **Loja Shai** — uma loja de roupas com 2 lojas físicas + vendas online via WhatsApp, Instagram e site.

O objetivo é receber mensagens de todos os canais em um único painel, classificar por urgência automaticamente, e permitir fechar vendas sem abrir o WhatsApp.

---

## 🔗 REPOSITÓRIOS E SERVIÇOS

| Serviço | URL / Info |
|---|---|
| GitHub | https://github.com/arthurlara000/shaiinbox |
| Netlify (produção) | https://shaiinbox.netlify.app |
| Supabase projeto | ID: `ofoljmhfnohxwswskplx` |
| Supabase região | sa-east-1 (São Paulo) |
| Supabase DB host | db.ofoljmhfnohxwswskplx.supabase.co |

**Deploy automático:** push na branch `main` → Netlify publica automaticamente em ~22s.

---

## 🎨 IDENTIDADE VISUAL

```css
/* Paleta principal */
--bg: #0f0f0f;           /* fundo geral */
--surface: #1a1a1a;      /* cards e header */
--surface2: #222;        /* inputs e itens */
--border: #2e2e2e;       /* bordas */
--text: #f0ede8;         /* texto principal */
--text-muted: #666;      /* texto secundário */
--accent: #c9a96e;       /* dourado Shai — cor principal */

/* Urgência */
--red: #e05252;          /* URGENTE (+15 min sem resposta) */
--yellow: #e0b452;       /* ATENÇÃO (5-15 min) */
--green: #52b88a;        /* NORMAL (0-5 min) */

/* Canais */
--loja1: #7b8cde;        /* WhatsApp Loja 1 — azul */
--loja2: #de7bb8;        /* WhatsApp Loja 2 — rosa */
--insta: #f77737;        /* Instagram — laranja */
--site: #7bcfde;         /* Site — ciano */
```

**Fontes:** `Playfair Display` (logo/títulos) + `DM Sans` (corpo)

---

## ⏱ REGRAS DE URGÊNCIA

```
0 – 5 min   → 🟢 NORMAL
5 – 15 min  → 🟡 ATENÇÃO
+15 min     → 🔴 URGENTE (pisca, sobe pro topo)
```

Timer começa quando cliente manda mensagem.
Timer zera quando atendente responde.

---

## 📱 RESPONSIVIDADE

- **Desktop (≥768px):** sidebar fixa + chat + painel de venda lateral
- **Mobile (<768px):** lista em tela cheia → chat em tela cheia → painel de venda como bottom sheet
- **Bottom nav mobile:** INBOX / VENDA / URGENTE

---

## 🗄️ BANCO DE DADOS (Supabase)

### Tabelas criadas

```
canais          → Loja 1, Loja 2, Instagram, Site
clientes        → dados dos clientes
conversas       → atendimentos com timer e urgência
mensagens       → todas as mensagens trocadas
categorias      → Vestidos, Calças, Blusas, etc.
produtos        → catálogo com tamanhos e estoque
produto_fotos   → fotos de cada produto
orcamento_itens → produtos selecionados por conversa
vendas          → vendas fechadas com status de entrega
```

### Storage
- Bucket: `produto-fotos` (público)
- Uso: upload de fotos dos produtos

### Canais cadastrados
```sql
Loja 1      | whatsapp  | +55219999-0001 | cor: #7b8cde
Loja 2      | whatsapp  | +55219999-0002 | cor: #de7bb8
Instagram   | instagram | @lojashai      | cor: #f77737
Site        | site      | lojashai.com.br| cor: #7bcfde
```

### Categorias cadastradas
Vestidos, Calças, Blusas, Blazers, Saias, Acessórios, Calçados

---

## 🏗️ ARQUITETURA ATUAL

```
index.html          → painel completo (single file, sem framework)
                      HTML + CSS + JS vanilla
```

### Stack planejada (próximas fases)
```
Frontend     → HTML/CSS/JS vanilla (já) ou migrar para React
Backend      → n8n (automações) + Supabase (dados)
WhatsApp     → Z-API (2 instâncias — Loja 1 e Loja 2)
Instagram    → redireciona para WhatsApp via link wa.me
Pagamentos   → PIX (chave manual) + Mercado Pago (futuro)
Hosting      → Netlify
```

---

## 📋 FUNCIONALIDADES IMPLEMENTADAS

### ✅ Inbox unificado
- Lista de conversas de todos os canais
- Filtro por canal (Loja 1, Loja 2, Instagram, Site)
- Busca por nome ou prévia
- Ordenação automática por urgência
- Badge de não lidas

### ✅ Timer de urgência ao vivo
- Contador em tempo real por conversa
- Barra de progresso visual
- Timer no topbar ao abrir conversa
- Zera automaticamente ao responder

### ✅ Chat
- Histórico de mensagens
- Campo de resposta (Enter envia, Shift+Enter quebra linha)
- Respostas rápidas horizontais
- Toast "✓ Enviado via Z-API"
- Botão "✓ Resolver"

### ✅ Painel de Venda
- Funil: Interesse → Produto apresentado → Em negociação → Fechado → Perdido
- Catálogo de produtos com busca
- Seleção de produtos + cálculo automático de total
- Botão "Enviar Orçamento" → manda mensagem formatada
- Botão "Fechar Venda"
- Botão "Gerar Link PIX"

### ✅ Mobile
- Layout responsivo completo
- Bottom nav (INBOX / VENDA / URGENTE)
- Painel de venda como bottom sheet
- Safe area para iPhone (notch + home indicator)

---

## 🚧 PRÓXIMAS FUNCIONALIDADES (backlog)

### FASE 2 — Cadastro de produtos
- [ ] Tela de cadastro de produtos (nome, preço, tamanhos, estoque)
- [ ] Upload de fotos → Supabase Storage bucket `produto-fotos`
- [ ] Envio de foto via Z-API ao selecionar produto
- [ ] Categorias e filtros no catálogo

### FASE 3 — Integração real
- [ ] Z-API webhook → recebe mensagens reais no Supabase
- [ ] Z-API send → envia mensagens direto do painel
- [ ] n8n classifica urgência via Claude API (palavras-chave + tempo)
- [ ] Supabase Realtime → inbox atualiza sem recarregar

### FASE 4 — CRM
- [ ] Histórico completo por cliente
- [ ] Tags e anotações
- [ ] Relatório de vendas por canal
- [ ] Disparo de campanhas (nova coleção, promoção)

---

## 🔧 VARIÁVEIS DE AMBIENTE (a configurar)

```env
# Supabase
SUPABASE_URL=https://ofoljmhfnohxwswskplx.supabase.co
SUPABASE_ANON_KEY=<pegar no painel Supabase>
SUPABASE_SERVICE_KEY=<pegar no painel Supabase>

# Z-API Loja 1
ZAPI_INSTANCE_L1=<seu_instance_id>
ZAPI_TOKEN_L1=<seu_token>

# Z-API Loja 2
ZAPI_INSTANCE_L2=<seu_instance_id>
ZAPI_TOKEN_L2=<seu_token>

# n8n
N8N_WEBHOOK_URL=<sua_url_n8n>
```

---

## 📁 ESTRUTURA DE ARQUIVOS (atual e planejada)

```
shaiinbox/
├── index.html              ← painel principal (atual)
├── CLAUDE.md               ← este arquivo
├── .gitignore
│
├── pages/                  ← futuro (quando separar)
│   ├── produtos.html       ← cadastro de produtos
│   └── relatorios.html     ← dashboard de vendas
│
├── assets/
│   ├── css/
│   └── js/
│
└── api/                    ← Edge Functions Supabase (futuro)
    ├── webhook-zapi.js
    └── send-message.js
```

---

## 🚀 FLUXO DE DEPLOY

```bash
# Fazer uma alteração
git add .
git commit -m "feat: descrição da mudança"
git push origin main
# → Netlify detecta e publica em ~22s automaticamente
```

---

## 👤 CONTEXTO DO NEGÓCIO

- **Proprietária:** Mariana (sócia-administradora)
- **Operação:** Arthur (comercial e tecnologia)
- **Lojas físicas:** 2 (Loja 1 e Loja 2)
- **Canais de venda:** WhatsApp, Instagram, Site
- **Produto:** Moda feminina
- **Foco:** Atendimento rápido + conversão de vendas via chat

---

## 💡 DECISÕES DE DESIGN

1. **Single HTML file** → fácil de editar, deploy simples, sem build step
2. **Tema dark** → reduz cansaço visual para atendente que fica o dia todo no painel
3. **Dourado (#c9a96e)** → cor da marca Shai, premium
4. **Instagram redireciona pro WhatsApp** → evita Meta API, zero burocracia
5. **Timer por tempo** → urgência objetiva, sem depender de IA para classificar

