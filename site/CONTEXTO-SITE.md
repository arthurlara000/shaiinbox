# Contexto — Site da Shai (Nuvemshop + Shai Site)

Documento para começar a conversa sobre o site. Decisões tomadas com o Arthur em 14/10/2026.
Estrutura do site construída em 02/11/2026 — ver seções 9 (o que existe) e 10 (roteiro).

---

## 1. Princípio que manda em tudo

- **Um app por função.** Cada pessoa só aprende o app dela:
  - lojas → **Shai Vendas** (caixa / PDV) — `vendas/`, shai-vendas.netlify.app
  - CD → **Shai Compras** (cadastro em grade, etiquetas, distribuição) — `compras/`, shai-compras.netlify.app
  - quem cuida do site → **Shai Site** (novo: fotos, legendas, publicar)
  - Arthur e Mariana (donos) → **Manager** — `manager/`, shaiinbox.netlify.app
- Motivo (Arthur): "os 2 ERPs que usamos ninguém usa direito, os dados ficam todos mal feitos e é muito complexo de mexer".
  O jeito certo tem que ser o mais fácil: menos digitação, menos botões, nada de abrir ERP no dia a dia.

## 2. Arquitetura decidida

**O Supabase é o sistema da Shai. O Bling só recebe.**

```
Shai Compras: cadastro + entrada no CD
        │
        ▼  distribuir em grade
  ┌─────────────┬──────────────┬──────────┐
Loja Areal   Loja Três Rios      Site
(Shai Vendas) (Shai Vendas)   (Nuvemshop)
        │
        ▼  toda venda baixa o MESMO estoque, na hora
     Supabase ──► Manager (ao vivo)
        │
        ▼  fim do dia (na hora: venda com nota e pedido pago do site)
      Bling = só nota fiscal, financeiro e contador
```

- **4 locais de estoque:** CD, Areal, Três Rios e **Site**.
- **Bling:** recebe tudo no fim do dia (antes do `bling-sync` das 23h40). Vai **na hora** só: venda de balcão
  marcada "precisa de nota" e **pedido pago do site** (precisa da NF-e para despachar). Conferência diária
  de saldos Supabase × Bling com alerta no Manager. Bling também é plano B se o nosso sistema falhar.
- **Regras de ouro:** ninguém cadastra produto nem mexe em estoque direto no Bling; na Nuvemshop ninguém
  cria produto nem mexe em estoque (lá só aparência da loja, banners, promoções — isso é do Arthur).
- **NÃO ligar a integração nativa Nuvemshop ↔ Bling para estoque** (faria o Bling voltar a mandar no
  estoque do site → dois estoques desencontrados). A Nuvemshop conversa com o Supabase; o Supabase com o Bling.

## 3. Fluxo do site (combinado)

1. **CD cadastra no Shai Compras** — **sem foto** (o recebimento tem que ser rápido; lote chega sem nota).
   A peça sobe para a Nuvemshop como **rascunho escondido**, já com código, cores, tamanhos e preço.
2. **CD distribui peças para o "Site"** (nova coluna na distribuição). O saldo do local Site vai para a
   Nuvemshop em poucos minutos. Fisicamente as peças do site provavelmente ficam no CD (reserva separada).
3. **Shai Site** (app de quem cuida do site): lista **"Falta foto"** com as peças distribuídas ao Site →
   tira foto pelo celular ou escolhe da galeria, ordena (1ª = capa) → escreve a legenda/descrição →
   **Publicar** (fotos + descrição + preço sobem para a Nuvemshop). Editar e publicar de novo para corrigir.
   Opcional: botão "sugerir descrição" (IA olha foto + nome e propõe texto no tom da Shai).
4. **Cliente compra na Nuvemshop** → webhook → pedido cai no Supabase → baixa o estoque do Site →
   aparece no Manager → entra na aba **"Pedidos" do Shai Site** (quem cuida do site separa, embala, etiqueta de envio).
5. **Pedido pago** → Bling na hora (NF-e que vai no pacote). Cancelado / não pago → peça volta ao estoque do Site.

Fotos ficam guardadas no Supabase (bucket `produto-fotos`, público) — servem também para o caixa mostrar
a peça ao bipar, o Manager (mais vendidas com foto) e mandar pelo WhatsApp. Se trocar de plataforma, nada se perde.

## 4. API da Nuvemshop (conferida na documentação em 14/10/2026)

Doc: https://tiendanube.github.io/api-documentation/
- **Estoque por variação:** `POST /products/{product_id}/variants/stock` (`action` = `replace` ou `variation`,
  `value`, `id` da variação opcional). Não há endpoint de estoque em massa entre produtos (um produto por vez;
  `PATCH /products/{id}/variants` atualiza as variações de um produto). Se a loja ativar **Múltiplos locais**,
  o campo `stock` fica obsoleto → usar `inventory_levels` com `location_id` (`GET /locations`).
- **Produto:** `name` e `description` (HTML) por idioma, `seo_title` (70), `seo_description` (320), `tags`,
  `categories`, `published` **ou** `visibility` (nunca os dois → 422), `attributes` até 3 (ex.: Cor, Tamanho),
  `variants` com `price`, `stock`, `weight`, `cost`.
- **Imagens:** `POST /products/{id}/images` com `src` (URL) ou `attachment` (base64) + `filename`, `position`.
  Até 10 MB, jpg/png/gif/webp, máx. 250 por produto. A doc **não mostra** como ligar foto a uma cor
  específica → testar quando a loja existir.
- **Webhooks:** `POST /webhooks` (evento + URL **HTTPS**, não pode localhost). Eventos de pedido: created, paid,
  cancelled, packed, fulfilled, updated, voided...; de produto: created, updated, deleted. Resposta 2XX em até
  **3 s**; reenvia até 16 vezes em ~48 h; podem chegar **fora de ordem ou duplicados** → tratar idempotência.
  Assinatura: header `x-linkedstore-hmac-sha256` = HMAC-SHA256 do corpo cru com o segredo do app.
- Acesso: criar um **aplicativo** na área de parceiros da Nuvemshop e instalar na loja (gera o access token).

## 5. O que já existe no Supabase (projeto `ofoljmhfnohxwswskplx`, sa-east-1)

Tabelas do Shai Compras (fonte do cadastro e do estoque):
- `produtos` — id uuid, **codigo int (numérico, igual ao Bling)**, nome, categoria, fornecedor, ref_fornecedor,
  custo, preco, ativo, bling_id, fornecedor_id
- `produto_variacoes` — id uuid, produto_id, **cor, tamanho**, sku (= número), **ean** (EAN13 = código com
  zeros à esquerda até 12 + DV, o mesmo da etiqueta do Bling), bling_id
- `estoque_movimentos` — variacao_id, **local** (check: 'CD' | 'Areal' | 'Tres Rios' | **'Site'** — incluído em 19/10/2026), qtd (±), tipo
  ('entrada' | 'transferencia' | 'ajuste'), recebimento_id, distribuicao_id, ajuste_id, custo_unit, **bling_enviado**
- `v_estoque` — saldo por variação: colunas cd, areal, tres_rios, **site** (soma dos movimentos)
- `distribuicoes` (origem 'CD' | 'Areal' | 'Tres Rios' | 'Site'; status rascunho/enviada/cancelada) e
  `distribuicao_itens` (variacao_id, loja destino, qtd)
- RPCs: `compras_receber`, `compras_enviar_distribuicao`, `compras_ajustar_estoque`, `compras_corrigir_recebimento`
- Storage: bucket `produto-fotos` (público), `notas-despesas`

**Feito em 19/10/2026:** `'Site'` nos checks, coluna `site` na `v_estoque`, Site no Estoque/Distribuir/Ajuste do Shai Compras
(CD → Site e Site → CD). **Ainda falta para o site:** mapear produto/variação ↔ IDs da Nuvemshop; tabela de fotos/descrição (ou usar `produto_fotos`, que vem do
projeto Inbox antigo — conferir antes); tabela de pedidos do site.

Tabelas do caixa (Shai Vendas / PDV): `pdv_vendas`, `pdv_trocas`, `pdv_vales`, `pdv_caixas`, `pdv_caixa_movs`,
`pdv_crediario`, `pdv_config`, `pdv_catalogo` (espelho do Bling — vai ser trocado pela leitura de `produtos`/`v_estoque`).
Edge Functions: `pdv` (ponte com o Bling), `bling-sync` (Bling → Manager, cron 23h40).

## 6. Padrão técnico dos apps

- Monorepo `github.com/arthurlara000/shaiinbox`, push na `main` publica no Netlify.
- Cada app = uma pasta com **um `index.html` só** (HTML + CSS + JS vanilla, sem build), PWA; cada pasta é um site
  Netlify com a variável `SITE_DIR=<pasta>`. Novo app (ex.: `site/`) = nova pasta + novo site Netlify.
- Supabase via supabase-js; RLS com `shai_email_ok()`, `shai_equipe()`, `shai_loja()` (user_metadata.loja).
- Edge Functions com `verify_jwt` desligado e autenticação própria (JWT `@shai.local` ou `?key=` = `bling_config.sync_secret`).
  Webhook da Nuvemshop seria uma Edge Function nova validando o HMAC.
- Bling: limite de 3 requisições/s; o refresh_token **rotaciona** — sempre usar a mesma linha `bling_tokens`
  e a mesma lógica de renovação (dois processos renovando por conta própria se derrubam).
- Visual: paleta "café com leite" da marca (chocolate/caramelo/nude do feed @loja.shai).
- Arthur testa local (file:// ou servidor local) e só sobe quando aprova.
- Mix: moda feminina, sem calçados e sem plus size; tamanhos PP–GG, U e 34–48. Variação = **cor × tamanho**.

## 7. Ordem combinada dos passos

1. **Separar os logins** — **feito em 15/10/2026**: contas `donos@`, `cd@`, `lojaareal@`, `lojatresrios@`,
   `calendario@shai.local`, papel em `raw_app_meta_data.papel` e funções `shai_cd()`, `shai_pdv()`,
   `shai_calendario()`. O Shai Site vai precisar de uma conta e papel próprios (ex.: `site`) no mesmo padrão.
   Senhas só em `_privado/senhas-shai.html` (fora do Git).
2. **Site como 4º local** no Shai Compras (estoque + coluna na distribuição).
3. **Caixa lendo o estoque do Supabase** (vendas e trocas baixando `estoque_movimentos`).
4. **Envio ao Bling** (na hora p/ nota; fim do dia p/ o resto) + conferência diária.
5. **Ponte Nuvemshop + app Shai Site (peças e pedidos).**

Os passos 1–4 não dependem da loja Nuvemshop existir.

## 7b. Estratégia comercial (Arthur, 19/10/2026)

- O site é para **clientes de fora da região** (fora de Areal/Três Rios), não para competir com as lojas.
- Canal principal de aquisição: **collabs com influenciadoras/criadoras de fora da região**.
- Consequências para o sistema: **cupom/link por collab** para medir venda e pagar comissão de cada
  parceira; relatório no Manager com o site como 3ª "loja" (faturamento, margem, venda por collab);
  política de troca à distância e frete bem definidos.
- **O ganho da collab é a cliente nova, não a margem da 1ª venda** (Arthur): aceita margem menor na
  1ª compra. Medir por collab: clientes novas, custo por cliente nova e quanto ela recompra depois
  (90 dias / 12 meses). Exige guardar o contato (WhatsApp) de toda cliente do site e ligar recompras a ela.
- Conta de margem (19/10): na loja sobram ~R$ 41 de cada R$ 100; no site estimar ~R$ 30–35 antes de
  comissão de collab e anúncio (gateway 4–5%, frete, embalagem, devoluções).

## 7c. Site no Manager e no painel da TV (pronto desde 26/10/2026)

- O banco aceita `loja = 'Site'` em `vendas`, `fechamento_dia`, `metas_semanais`, `metas_mensais`, `despesas`
  e `custos_fixos` (as checagens foram ampliadas).
- **Quando os pedidos do site chegarem (webhook da Nuvemshop), gravar em `vendas` (uma linha por dia ou por
  pedido, sem vendedora) e em `fechamento_dia` (formas de pagamento) com `loja = 'Site'`** — é isso que o
  Manager (Dashboard, Vendas, Metas, Custos fixos, Fechamentos) e o painel `manager/tv.html` leem.
  Se gravar peças em `vendas_itens` com `loja = 'Site'`, entra também em "O que está vendendo".
- **Tabela `site_pedidos` criada (26/10)** para os pedidos da Nuvemshop: `nuvemshop_id` (único), `numero`, `data`,
  `criado_em`, `status` (aberto/pago/enviado/entregue/cancelado), cliente (nome, whatsapp, cidade, uf), `cupom`
  (collab), subtotal/desconto/frete/total, `forma_pagamento`, `itens` jsonb `[{codigo, descricao, cor, tamanho, qtd, valor}]`.
  RLS: só leitura para donos e CD (`shai_equipe()`/`shai_cd()`); quem grava é o webhook com service role.
  Está no realtime: o "Hoje ao vivo" da TV mostra o pedido na hora (valor, cidade/UF e cupom).
  Pode ser ajustada quando o webhook for feito — por enquanto está vazia.
- No painel da TV o Site só aparece quando tiver venda, meta ou pedido no dia; margem de contribuição do site = 33%
  (`MARGEM.Site` em tv.html). Cor do Site: #3a7d74 (igual ao Compras).

## 7e. Um sistema por setor (Arthur, 02/11/2026)

**Tudo do site fica no Shai Site** — peças, fotos, publicação, **pedidos, separação, envio com rastreio, nota pendente**.
Cada setor tem o seu app e, no futuro, cada pessoa mexe só no dela. O Shai Compras (CD) não tem nada do site além de
**distribuir peças para o local Site** (e receber de volta). Collabs/relatórios ficam no Manager (donos).

## 7f. Venda do começo ao fim + etiqueta (decidido 02/11/2026)

Ordem: pago → separar → **emitir NF-e** → **gerar etiqueta (com a chave da NF)** → postar → rastreio (Nuvemshop avisa a cliente).
Frete e forma de envio já vêm no pedido (a cliente escolhe no checkout).
- **Etiqueta = opção B: dentro do Shai Site via API do Melhor Envio** (Arthur: "quero ter trabalho pra criar, mas quem operar
  vai ter facilidade"). Nada de abrir o painel da Nuvemshop no dia a dia. Botão "Gerar etiqueta" no pedido: carrinho →
  compra com o saldo da carteira Melhor Envio → gerar → imprimir PDF → rastreio preenchido sozinho → "Marcar como enviado".
- Para o serviço bater com o que a cliente escolheu, o **frete do checkout da Nuvemshop deve ser calculado pelo Melhor Envio**
  (app do Melhor Envio na Nuvemshop) — confirmar quando configurar a loja.
- Precisa: conta Melhor Envio da Shai (CNPJ + endereço de remetente), saldo na carteira, aplicativo na área de dev do Melhor Envio
  (client id/secret + URL de retorno = Edge Function), testar primeiro no **sandbox** (sandbox.melhorenvio.com.br).
- NF-e antes da etiqueta: até a "nota sob demanda" existir, a chave da NF digitada/colada no pedido.

**Construído (02/11):** migração `20261102b_site_etiqueta.sql` (aplicada): `melhorenvio_config` (ambiente sandbox/producao,
client id/secret, tokens 30 dias com renovação, **remetente = dados do CD**, embalagem padrão 32×25×5 cm + 80 g) e em
`site_pedidos`: `nf_chave`, `etiqueta_status` (carrinho/paga/gerada/cancelada), `etiqueta_me_id`, `etiqueta_servico`,
`etiqueta_preco`, `etiqueta_url`, `etiqueta_em`. Função `supabase/functions/melhorenvio` (escrita e checada, **não publicada**):
conectar (link OAuth; URL de retorno `https://ofoljmhfnohxwswskplx.supabase.co/functions/v1/melhorenvio`), status (saldo),
cotar (peso = soma do peso_g das peças + embalagem; sugere o serviço que a cliente escolheu), etiqueta (carrinho → checkout com
saldo → gerar → link público de impressão → rastreio; retomável se cair no meio), imprimir, rastreio, cancelar.
No Shai Site: nota com número + chave; no pedido "separado": Ver fretes → escolher → Comprar e gerar etiqueta → Imprimir;
sem nota só com "declaração de conteúdo"; se o Melhor Envio não estiver conectado, campo manual de rastreio.
**Falta do Arthur:** conta sandbox do Melhor Envio, aplicativo lá (client id/secret com a URL de retorno acima), dados do
remetente (razão social, CNPJ, IE, telefone, e-mail, endereço do CD) e medida da embalagem que vão usar.

## 7d. Escopo desta conversa (02/11/2026)

A conversa do site trata **só do site** (Nuvemshop, Shai Site, pedidos do site). A ideia do Arthur de **tirar o
Bling de tudo** (ERP próprio, Bling só emite nota sob demanda, como no hortifruti) vai para outra conversa.
Para o site isso só muda o passo da nota: o pedido pago chama a "API de nota sob demanda" de lá; até ela existir,
a NF-e do site sai na mão no Bling (`site_pedidos.nf_status` = pendente/emitida/manual/erro).

## 9. Estrutura construída (02/11/2026)

**Banco** (migração `supabase/migrations/20261102_site_nuvemshop.sql`, já aplicada — tudo aditivo):
- Papel `site` (`shai_site()` = dono ou site). Conta `site@shai.local` **ainda não criada** (Arthur define a senha).
- `produtos`: `site_status` (fora → rascunho → publicado / pausado), `site_nome`, `site_descricao`, `site_preco`
  (vazio = preço da loja), `peso_g`, `nuvemshop_id`, `site_erro`, `site_publicado_em`, `site_atualizado_em`.
- `produto_variacoes.nuvemshop_variant_id`. `produto_fotos` (produto, cor opcional, path/url no bucket, posição 0 = capa,
  `nuvemshop_image_id`). Bucket `produto-fotos` aceita o papel site.
- `nuvemshop_config` (linha única, só o servidor lê): client_id, client_secret (também chave do HMAC), store_id, access_token.
- `site_fila` (produto/estoque/fotos; um pendente por peça+ação; 5 tentativas → 'erro'). Gatilhos enfileiram sozinhos:
  movimento no local Site → estoque; mudança de nome/preço/descrição/status → produto; cor/tamanho novo → produto.
- `estoque_movimentos.tipo` aceita `venda` e `estorno` (+ `site_pedido_id`). O caixa vai usar o mesmo tipo depois.
- `site_pedidos`: status aberto → pago → separado → enviado → entregue / cancelado; + endereço, rastreio, pago_em,
  estoque_baixado, nf_status/nf_numero. Só o setor do site (papel site/dono) lê e edita. `site_webhook_log` (avisos crus). `collabs` (cupom, % comissão).
  `clientes` + email, cidade, uf, cupom_origem.

**Regra que mudou:** a peça **não** vai para a Nuvemshop no cadastro; vai quando o CD distribui para o Site
(primeiro movimento no local Site → cria a peça escondida, status rascunho). Menos peças paradas lá.

**Funções** (nuvemshop publicada em 02/11 — ver 9b) — `supabase/functions/`:
- `nuvemshop`: `autorizar` (volta da instalação do app; troca code por token e já cadastra os webhooks), `status`,
  `webhooks`, `sync` (processa a fila; com produto_id = na hora), `enviar` (CD despacha com rastreio → Nuvemshop avisa a cliente).
  Estoque enviado = saldo Site − peças de pedidos ainda não pagos (a Nuvemshop já tirou do estoque dela).
  Categoria criada na Nuvemshop pelo nome do cadastro. Foto com cor marcada vira a imagem das variações daquela cor.
- `nuvemshop-webhook`: confere HMAC, grava log, responde 200 e processa depois relendo o pedido na API (idempotente).
  Pago → baixa estoque do Site (uma vez só) + cliente + refaz o dia do Site em `vendas`/`fechamento_dia`/`vendas_itens`
  (faturamento = subtotal − desconto, sem frete). Cancelado → devolve ao estoque. `?reprocessar=1&key=` refaz avisos com erro.
- Falta: publicar as duas (verify_jwt off) e criar o cron `nuvemshop-sync` a cada minuto (mesmo padrão do `pdv-fila`).

**App Shai Site** — pasta `shai-site/` (não `site/`, para este arquivo não ser publicado junto):
listas Falta foto / Pronta / No ar / Todas; na peça: fotos pelo celular (reduz para 1600 px antes de subir), ordem,
cor da foto, nome no site, descrição, preço do site, peso; Publicar / Atualizar no site / Tirar do ar; mostra erro de envio
com "Tentar de novo". Login: `site@shai.local` ou `donos@shai.local`. Falta: site Netlify (SITE_DIR=shai-site), manifest/ícones.

**Aba Pedidos no Shai Site (02/11):** seções Peças | Pedidos (selo vermelho = pedidos a enviar). Abas A enviar /
Aguardando pagamento / Enviados / Cancelados (últimos 90 dias). No pedido: checklist das peças com foto da cor (fica no aparelho),
"Separado e embalado" → rastreio → "Marcar como enviado" (ação `enviar`; Nuvemshop avisa a cliente), endereço, WhatsApp
(link wa.me), cupom, totais, nota fiscal pendente com campo para anotar o número (nf_status 'manual'). Pedido pago chega ao vivo
(realtime) com aviso na tela. Testado com pedido de exemplo na tela; não testado com pedido real (loja não conectada).

**Ainda não feito:** relatório de collabs
no Manager, botão "sugerir descrição" (IA), nota fiscal (outra conversa).

## 9b. Loja conectada e ponte no ar (02/11/2026)

- Loja Nuvemshop **8381087** autorizada (feito numa conversa do Cowork, que publicou uma versão simples da função).
- Nesta conversa a função `nuvemshop` foi **substituída pela versão completa** (v2) — `supabase/functions/nuvemshop/index.ts`
  + `pedido.ts` (processamento de pedidos). A pasta `nuvemshop-webhook` deixou de existir: os avisos chegam em
  `nuvemshop?acao=webhook` (endereço que já estava cadastrado na Nuvemshop). Mantidas as rotas `lgpd_*` (só log).
  **Não publicar outra versão desta função de outra conversa** sem partir destes arquivos.
- Cron `nuvemshop-sync` a cada minuto (só chama se houver pendente na `site_fila`) e `nuvemshop-reprocessar` a cada 15 min
  (refaz avisos de pedido que falharam).
- Teste real: Blusa Decotada (2022) distribuída ao Site → criada **escondida** na Nuvemshop (produto 378415500, 2 variações ligadas).
- Falta testar: pedido-teste (precisa do Nuvem Pago ativo), publicar pelo Shai Site com foto, enviar com rastreio.
- **Melhor Envio conectado em PRODUÇÃO (03/11)** pela conversa do Cowork, que de novo publicou uma versão só de conexão
  (sem cotar/etiqueta). Nesta conversa a função `melhorenvio` foi juntada (v4): etiqueta completa + o jeito de conectar do
  Cowork (state de uso único gravado em `site_webhook_log`, URL de retorno `.../melhorenvio?acao=autorizar` — tem que ser
  idêntica à do aplicativo) + `?acao=renovar` (cron `melhorenvio-renovar` toda segunda 04:20). Respostas em texto simples.
- **Regra: as funções `nuvemshop` e `melhorenvio` só se mexem a partir de `supabase/functions/` desta pasta.** O Cowork já
  substituiu as duas por versões simples; se acontecer de novo, o Shai Site perde pedidos/estoque/etiqueta.
- **Remetente gravado (03/11):** SHAI MODAS E ACESSORIOS LTDA, CNPJ 55.073.520/0001-16 (ME, CNAE 47.81-4-00), Praça Presidente
  Castelo Branco 52, Loja 1, Centro, Areal/RJ, tel. (24) 99945-1872, shaiecommerce@outlook.com. **CEP de envio 25847-030**
  (o 25845-000 do cartão CNPJ é o CEP geral da cidade e o Melhor Envio recusa). Sai da loja de Areal, não de um CD separado.
  **Falta a inscrição estadual** (obrigatória no envio com nota). Embalagem ainda não definida: padrão 32×25×5 cm, 80 g.
- Cotação real testada Areal → São Paulo (0,48 kg): PAC R$ 33,29 (10 dias), SEDEX R$ 62,71 (2 dias). Só Correios aparecem:
  outras transportadoras (Jadlog, Loggi, J&T...) precisam ser ativadas no painel do Melhor Envio.
- **Pesquisa de transportadoras (03/11, cotação real, saindo de Areal, pacote 32×25×5 cm 0,48 kg, seguro R$ 150):**

  | Destino | Jadlog .Com | Jadlog .Package | Loggi Express | Azul e-commerce | Correios PAC | Correios SEDEX |
  |---|---|---|---|---|---|---|
  | Rio (capital) | 14,07 · 2d | 16,71 · 3d | 17,64 · 3d | 28,73 · 3d | 24,69 · 8d | 27,60 · 2d |
  | São Paulo | 17,70 · 5d | 22,14 · 6d | 22,01 · 4d | 24,90 · 3d | 33,29 · 10d | 62,71 · 2d |
  | Belo Horizonte | 21,06 · 5d | 24,85 · 6d | 15,54 · 4d | 24,90 · 3d | 33,29 · 12d | 62,71 · 2d |
  | Curitiba | 19,04 · 3d | 22,83 · 4d | 18,28 · 5d | 27,05 · 3d | 33,29 · 10d | 62,71 · 2d |
  | Porto Alegre | 21,92 · 4d | 22,14 · 9d | 18,09 · 6d | 29,70 · 3d | 40,01 · 12d | 79,94 · 3d |

  Não atendem Areal: LATAM Cargo, Total Express, Buslog, Loggi Coleta/Ponto; J&T indisponível no dia. Correios Mini Envios
  não aceita a caixa 32×25×5 (só envelope pequeno). Falta saber **onde postar** cada uma (Jadlog/Loggi/Azul exigem levar
  a um ponto — achar o mais perto de Areal/Três Rios).
- **Pontos de postagem (03/11, lista de agências do Melhor Envio):**
  - Areal: **só Correios** — AC Areal, Praça Pres. Castelo Branco 365 (mesma praça da loja).
  - Três Rios: Correios (AC Praça São Sebastião 250; AGC Bemposta, R. Werneck 425); **Jadlog** — King Reparos 2,
    Praça Sallim Chimelli 56; **J&T** — YoYi! R. do Quincão 69 e Av. Zoello Sola (Triângulo).
  - Levy Gasparian: **Jadlog CO Três Rios 01** (centro de operações), Estrada União Indústria km 130.
  - Petrópolis: Loggi Ponto (R. Galdino Pimentel 222, Bingen), Azul Cargo (R. Dr. Paulo Hervé 1436, Bingen), muitos Jadlog/J&T.
  - Conclusão: no dia a dia **Jadlog (Três Rios) + Correios (Areal)**; Loggi e Azul só indo a Petrópolis.
- **Decidido (03/11): Jadlog é a transportadora principal, postada em Três Rios** (King Reparos 2 = agência 28216 no
  Melhor Envio). Correios (Areal) para SEDEX/urgente e onde a Jadlog não chega. Banco: `melhorenvio_config.servicos =
  '3,4,1,2'` (só esses aparecem na cotação do Shai Site) e `agencia_jadlog = 28216` (vai no carrinho da etiqueta Jadlog).
  Função `melhorenvio` v5. Mudar de ponto/transportadora = só trocar esses dois campos.
- **RY Transportadora — região local (03/11, respostas do dono):** atende **só** Petrópolis, Teresópolis, Três Rios,
  Paraíba do Sul, Levy Gasparian, Chiador (MG), Sapucaia, Areal e São José do Vale do Rio Preto — **não** atende Rio capital
  nem Niterói. **R$ 12 fixo** por pacote (acima do peso padrão é cotado), **prazo 72 h**, **coleta todo dia** em Areal.
  Pedido, pagamento e rastreio pelo app **RyLog Transportadora** (Android `com.ry.transportadora.usuarioapp`; iOS id6443945734).
  Sem API conhecida → no Shai Site, pedido para essas cidades abre "Envio pela RY" (lançar no app RyLog, rastreio digitado à
  mão); demais destinos: Jadlog pelo Melhor Envio. `site_pedidos.transportadora` guarda com quem saiu.
  **No checkout:** criar na Nuvemshop um frete próprio para os CEPs dessas cidades (R$ 12–15) e, para Areal e Três Rios,
  **retirada na loja** grátis. Como o site mira clientes de fora da região, a RY vai cobrir poucos pedidos.
- **Configurado na Nuvemshop (03/11):** frete "**Entrega Shai Serra**" R$ 14,90 (RyLog R$ 12 + R$ 2,90 embalagem), 1–3 dias
  úteis, por município (Petrópolis, Teresópolis, Três Rios, Paraíba do Sul, Levy Gasparian, Sapucaia, Areal, S. José do
  Vale do Rio Preto, Chiador/MG — inclui distritos como Itaipava). **Retirada na loja** grátis, pronta em 1–2 dias úteis:
  Areal (Praça Pres. Castelo Branco 52, seg–sáb 9h–19h) e Três Rios (Shopping Américo Silva, sala 25 A, seg–sex 10h–20h,
  sáb 10h–18h).
- **Shai Site (03/11):** pedido com "Entrega Shai Serra" (ou cidade da lista) → "Envio pela RY". Pedido de **retirada**
  (`site_pedidos.retirada`, vem de `shipping_pickup_type = 'pickup'` — função nuvemshop v3) → sem etiqueta: separar →
  botão **Avisar** (WhatsApp pronto) → **Cliente retirou** (fecha na Nuvemshop e vira "entregue"). Atenção: a peça do site
  precisa estar fisicamente na loja escolhida (se a retirada for em Três Rios e a peça estiver em Areal, levar antes).
- **RY × Jadlog na região (03/11, cotação real, pacote 0,48 kg):** Jadlog .Com R$ 15,34 (Petrópolis/Itaipava, 3–4 d),
  R$ 16,75 (Teresópolis, Três Rios, Levy Gasparian, 4–5 d), R$ 18,17 (Paraíba do Sul, Sapucaia, S. José V. Rio Preto, 5–6 d),
  **R$ 45,47 Chiador** e **R$ 34,86 dentro de Areal**; SEDEX R$ 27,60 (2 d; Areal R$ 16,77). RY = **R$ 12, 72 h, coleta em
  Areal** → RY fica mais barata (R$ 3–6 por pacote), mais rápida e sem levar a Três Rios. Manter a RY na região.
- **App RyLog visto por dentro (03/11, conta da Mariana):** fluxo "Solicitar coleta" = local de coleta (padrão: loja de
  Areal) → dia e período da coleta → (destinatário, pacote, pagamento). Cada coleta ganha um **código alfanumérico** (ex.
  `I1UlUyiFglFyxrEG5L8S`), status (Aguardando pagamento → Coleta pendente → …), **pagamento Pix de R$ 12 por coleta** e
  "Transporte: aguardando entregador". A **etiqueta** = 2 blocos (remetente e destinatário) com o código + **QR Code** +
  "Compartilhar etiqueta pra impressão" (imagem do celular, não 10×15). Com a API: criar a coleta pelo Shai Site, guardar o
  código e imprimir a etiqueta Shai 10×15 com o código e o QR (confirmar com a RY o que o QR contém). Pedir também
  **cobrança semanal/mensal** em vez de um Pix por coleta.
- **Padrão de impressão (03/11, pedido do Arthur): toda etiqueta sai em 10 × 15 cm**, para uma impressora térmica só.
  Melhor Envio (Jadlog/Correios): função `melhorenvio` v6 pede o arquivo **PDF** (`GET /api/v2/me/imprimir/pdf/{id}`;
  também existe `zpl` e `jpeg`), com o link de impressão como reserva. RY (até a API) e retirada: **etiqueta Shai 10×15**
  gerada no Shai Site (`abrirEtiqueta(o, 'ry'|'retirada')`, `@page 100mm 150mm`, código de barras = rastreio ou SHAI+nº do
  pedido). Quando chegar a API da RY, adaptar a etiqueta dela para o mesmo tamanho.
- **No checkout da Nuvemshop** (app Melhor Envio na loja): oferecer à cliente só Jadlog (.Com e .Package) e Correios
  (PAC/SEDEX), para não vender um frete que a Shai não consegue postar.

## 10. Roteiro do site (passos)

0. **Arthur — Nuvemshop:** terminar a loja (layout, frete, Nuvem Pago). Não cadastrar produto nem mexer em estoque lá.
   Criar o **aplicativo na área de parceiros** com URL de redirecionamento
   `https://ofoljmhfnohxwswskplx.supabase.co/functions/v1/nuvemshop?acao=autorizar` e permissões de produtos,
   pedidos e (se pedir) clientes/cupons. Passar client id + client secret.
1. **Conectar:** gravar client id/secret em `nuvemshop_config`, publicar as funções, instalar o app na loja
   (a função guarda o token e cadastra os webhooks), criar o cron do sync. Testar com 1 peça.
2. **Peças indo para o site:** distribuir 1 peça de teste ao Site no Compras → aparece escondida na Nuvemshop.
2b. **Etiqueta (Melhor Envio):** conta + app no Melhor Envio, testar no sandbox, botão "Gerar etiqueta" no pedido.
3. **Shai Site:** criar a conta `site@`, publicar o app, publicar a peça de teste pelo celular.
4. **Pedidos:** compra de teste → Manager/TV + aba "Pedidos" no Shai Site (separar → embalar → enviado com rastreio).
5. **Nota fiscal** do pedido pago (depende da conversa "sair do Bling"; até lá, manual).
6. **Collabs:** cadastro + cupom + relatório de clientes novas e recompra.

## 8. Perguntas em aberto

- O **preço do site** é igual ao da loja física? (se não, coluna "preço site" no cadastro)
- ~~Shai Site app próprio ou aba do Compras?~~ → **app próprio, com tudo do site** (02/11). Falta saber quem vai operar.
- Por qual **CNPJ** sai a nota do site? (contador)
- As peças do site ficam fisicamente no CD?
- Foto por cor funciona na Nuvemshop? (testar com a loja criada)
- Plano da Nuvemshop com acesso à API; criar o aplicativo na área de parceiros.
