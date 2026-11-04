-- Etiqueta de envio pelo Melhor Envio, dentro do Shai Site (decidido 02/11/2026). Já aplicada.
create table if not exists public.melhorenvio_config (
  id integer primary key default 1 check (id = 1),
  ambiente text not null default 'sandbox' check (ambiente in ('sandbox', 'producao')),
  client_id text,
  client_secret text,
  access_token text,
  refresh_token text,
  expira_em timestamptz,
  conectado_em timestamptz,
  -- remetente (de onde sai o pacote: o CD)
  rem_nome text, rem_cnpj text, rem_ie text, rem_telefone text, rem_email text,
  rem_cep text, rem_endereco text, rem_numero text, rem_complemento text, rem_bairro text, rem_cidade text, rem_uf text,
  -- embalagem padrão (cm) e peso da embalagem (g)
  emb_altura integer not null default 5, emb_largura integer not null default 25, emb_comprimento integer not null default 32,
  emb_peso_g integer not null default 80
);
insert into public.melhorenvio_config (id) values (1) on conflict do nothing;
alter table public.melhorenvio_config enable row level security;  -- só o servidor lê

alter table public.site_pedidos
  add column if not exists nf_chave text check (nf_chave is null or nf_chave ~ '^[0-9]{44}$'),
  add column if not exists etiqueta_status text check (etiqueta_status in ('carrinho', 'paga', 'gerada', 'cancelada')),
  add column if not exists etiqueta_me_id text,
  add column if not exists etiqueta_servico text,
  add column if not exists etiqueta_preco numeric(10,2),
  add column if not exists etiqueta_url text,
  add column if not exists etiqueta_em timestamptz;

-- (03/11) Transportadoras que a Shai consegue postar: Jadlog em Três Rios + Correios em Areal. Já aplicada.
alter table public.melhorenvio_config
  add column if not exists servicos text not null default '3,4,1,2',   -- ids Melhor Envio: 3 Jadlog .Package, 4 Jadlog .Com, 1 PAC, 2 SEDEX
  add column if not exists agencia_jadlog integer;                     -- ponto onde a Jadlog é postada
update public.melhorenvio_config set agencia_jadlog = 28216 where id = 1;  -- King Reparos 2, Praça Sallim Chimelli 56, Três Rios

-- (03/11) Com que transportadora o pedido saiu: RY (pedidos para o RJ, coleta em Areal), Jadlog, Correios... Já aplicada.
alter table public.site_pedidos add column if not exists transportadora text;

-- (03/11) Pedido para retirar na loja (Areal ou Três Rios): guarda o nome da loja; vazio = entrega. Já aplicada.
alter table public.site_pedidos add column if not exists retirada text;
