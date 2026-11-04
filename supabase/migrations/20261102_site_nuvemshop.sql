-- Site da Shai (Nuvemshop + app Shai Site) — estrutura no Supabase. 02/11/2026
-- Tudo aditivo: nada existente é apagado. O Supabase é o dono do cadastro e do estoque;
-- a Nuvemshop só recebe (peça, fotos, preço, estoque do local 'Site') e devolve os pedidos.

-- ───── papel 'site' (quem cuida das fotos/legendas) ─────
create or replace function public.shai_email_ok() returns boolean language sql stable set search_path to ''
as $$ select coalesce(auth.jwt()->>'email', '') like '%@shai.local' and public.shai_papel() in ('dono', 'cd', 'loja', 'calendario', 'site') $$;

create or replace function public.shai_site() returns boolean language sql stable set search_path to ''
as $$ select public.shai_email_ok() and public.shai_papel() in ('dono', 'site') $$;

-- ───── produto no site ─────
alter table public.produtos
  add column if not exists site_status text not null default 'fora'
    check (site_status in ('fora', 'rascunho', 'publicado', 'pausado')),
  add column if not exists site_nome text,            -- vazio = nome do cadastro
  add column if not exists site_descricao text,       -- texto da vitrine (HTML simples)
  add column if not exists site_preco numeric(10,2),  -- vazio = mesmo preço da loja
  add column if not exists peso_g integer,            -- para o frete; vazio = padrão da categoria
  add column if not exists nuvemshop_id bigint unique,
  add column if not exists site_publicado_em timestamptz,
  add column if not exists site_atualizado_em timestamptz,
  add column if not exists site_erro text;            -- último erro ao enviar para a Nuvemshop

alter table public.produto_variacoes
  add column if not exists nuvemshop_variant_id bigint unique;

-- ───── fotos (servem ao site, ao caixa, ao Manager e ao WhatsApp) ─────
create table if not exists public.produto_fotos (
  id uuid primary key default gen_random_uuid(),
  produto_id uuid not null references public.produtos(id) on delete cascade,
  cor text,                          -- vazio = vale para todas as cores
  path text not null,                -- caminho no bucket produto-fotos
  url text not null,                 -- URL pública
  posicao integer not null default 0, -- 0 = capa
  nuvemshop_image_id bigint,
  criado_em timestamptz not null default now()
);
create index if not exists produto_fotos_produto_idx on public.produto_fotos (produto_id, posicao);
alter table public.produto_fotos enable row level security;
create policy produto_fotos_ler on public.produto_fotos for select using (public.shai_email_ok());
create policy produto_fotos_site on public.produto_fotos for all using (public.shai_site()) with check (public.shai_site());

-- o app do site lê o catálogo/estoque e edita os campos do site
create policy shai_site_ler on public.produtos for select using (public.shai_site());
create policy shai_site_editar on public.produtos for update using (public.shai_site()) with check (public.shai_site());
create policy shai_site_ler on public.produto_variacoes for select using (public.shai_site());
create policy shai_site_ler on public.estoque_movimentos for select using (public.shai_site());

-- bucket produto-fotos: incluir o papel 'site'
drop policy if exists shai_fotos_select on storage.objects;
drop policy if exists shai_fotos_insert on storage.objects;
drop policy if exists shai_fotos_update on storage.objects;
drop policy if exists shai_fotos_delete on storage.objects;
create policy shai_fotos_select on storage.objects for select
  using (bucket_id = 'produto-fotos' and public.shai_email_ok() and public.shai_papel() in ('dono', 'cd', 'calendario', 'site'));
create policy shai_fotos_insert on storage.objects for insert
  with check (bucket_id = 'produto-fotos' and public.shai_email_ok() and public.shai_papel() in ('dono', 'cd', 'calendario', 'site'));
create policy shai_fotos_update on storage.objects for update
  using (bucket_id = 'produto-fotos' and public.shai_email_ok() and public.shai_papel() in ('dono', 'cd', 'calendario', 'site'))
  with check (bucket_id = 'produto-fotos' and public.shai_email_ok() and public.shai_papel() in ('dono', 'cd', 'calendario', 'site'));
create policy shai_fotos_delete on storage.objects for delete
  using (bucket_id = 'produto-fotos' and public.shai_email_ok() and public.shai_papel() in ('dono', 'cd', 'calendario', 'site'));

-- ───── conexão com a Nuvemshop (só o servidor lê: RLS ligado e nenhuma política) ─────
create table if not exists public.nuvemshop_config (
  id integer primary key default 1 check (id = 1),
  client_id text,          -- do aplicativo na área de parceiros
  client_secret text,      -- também é a chave do HMAC dos webhooks
  store_id bigint,         -- vem na autorização (user_id)
  access_token text,       -- não expira; some se o app for desinstalado
  autorizado_em timestamptz,
  webhooks_em timestamptz,
  peso_padrao_g integer not null default 400
);
insert into public.nuvemshop_config (id) values (1) on conflict do nothing;
alter table public.nuvemshop_config enable row level security;

-- ───── fila de envios para a Nuvemshop (nada se perde se a Nuvemshop cair) ─────
create table if not exists public.site_fila (
  id bigserial primary key,
  produto_id uuid not null references public.produtos(id) on delete cascade,
  acao text not null check (acao in ('produto', 'estoque', 'fotos')),
  status text not null default 'pendente' check (status in ('pendente', 'ok', 'erro')),
  tentativas integer not null default 0,
  erro text,
  criado_em timestamptz not null default now(),
  processado_em timestamptz
);
-- um pendente por produto+ação: dez movimentos seguidos viram um envio só
create unique index if not exists site_fila_pendente_uk on public.site_fila (produto_id, acao) where status = 'pendente';
alter table public.site_fila enable row level security;
create policy site_fila_ler on public.site_fila for select using (public.shai_site() or public.shai_cd());

create or replace function public.site_enfileirar(p_produto uuid, p_acao text) returns void
language sql security definer set search_path to ''
as $$ insert into public.site_fila (produto_id, acao) values (p_produto, p_acao) on conflict do nothing $$;

-- estoque do local Site mudou → manda o saldo novo para a Nuvemshop
create or replace function public.site_trg_estoque() returns trigger language plpgsql security definer set search_path to ''
as $$
begin
  if new.local = 'Site' then
    perform public.site_enfileirar(v.produto_id, 'estoque') from public.produto_variacoes v where v.id = new.variacao_id;
  end if;
  return new;
end $$;
drop trigger if exists site_estoque on public.estoque_movimentos;
create trigger site_estoque after insert on public.estoque_movimentos for each row execute function public.site_trg_estoque();

-- nome/preço/descrição mudou numa peça que já está na Nuvemshop → atualiza lá
create or replace function public.site_trg_produto() returns trigger language plpgsql security definer set search_path to ''
as $$
begin
  if new.site_status <> 'fora' and (
       new.nome is distinct from old.nome or new.preco is distinct from old.preco
    or new.site_nome is distinct from old.site_nome or new.site_descricao is distinct from old.site_descricao
    or new.site_preco is distinct from old.site_preco or new.peso_g is distinct from old.peso_g
    or new.site_status is distinct from old.site_status or new.categoria is distinct from old.categoria) then
    perform public.site_enfileirar(new.id, 'produto');
  end if;
  return new;
end $$;
drop trigger if exists site_produto on public.produtos;
create trigger site_produto after update on public.produtos for each row execute function public.site_trg_produto();

-- variação nova (cor/tamanho) numa peça que já está na Nuvemshop
create or replace function public.site_trg_variacao() returns trigger language plpgsql security definer set search_path to ''
as $$
begin
  perform public.site_enfileirar(new.produto_id, 'produto') from public.produtos p where p.id = new.produto_id and p.site_status <> 'fora';
  return new;
end $$;
drop trigger if exists site_variacao on public.produto_variacoes;
create trigger site_variacao after insert on public.produto_variacoes for each row execute function public.site_trg_variacao();

-- ───── venda baixa estoque (site agora; o caixa usa o mesmo tipo depois) ─────
alter table public.estoque_movimentos drop constraint if exists estoque_movimentos_tipo_check;
alter table public.estoque_movimentos add constraint estoque_movimentos_tipo_check
  check (tipo in ('entrada', 'transferencia', 'ajuste', 'venda', 'estorno'));
alter table public.estoque_movimentos add column if not exists site_pedido_id uuid references public.site_pedidos(id);

-- ───── pedidos do site ─────
alter table public.site_pedidos drop constraint if exists site_pedidos_status_check;
alter table public.site_pedidos add constraint site_pedidos_status_check
  check (status in ('aberto', 'pago', 'separado', 'enviado', 'entregue', 'cancelado'));
alter table public.site_pedidos
  add column if not exists cliente_email text,
  add column if not exists cliente_cpf text,
  add column if not exists endereco jsonb,
  add column if not exists envio_metodo text,
  add column if not exists rastreio text,
  add column if not exists pago_em timestamptz,
  add column if not exists enviado_em timestamptz,
  add column if not exists cancelado_em timestamptz,
  add column if not exists estoque_baixado boolean not null default false,
  add column if not exists nf_status text not null default 'pendente' check (nf_status in ('pendente', 'emitida', 'manual', 'erro')),
  add column if not exists nf_numero text,
  add column if not exists atualizado_em timestamptz not null default now();
-- o CD separa e despacha pelo Compras
create policy site_pedidos_cd_editar on public.site_pedidos for update using (public.shai_cd()) with check (public.shai_cd());

-- log cru dos webhooks (a Nuvemshop reenvia, manda fora de ordem e duplicado)
create table if not exists public.site_webhook_log (
  id bigserial primary key,
  evento text,
  nuvemshop_id bigint,
  corpo jsonb,
  recebido_em timestamptz not null default now(),
  processado_em timestamptz,
  erro text
);
alter table public.site_webhook_log enable row level security;
create policy site_webhook_log_ler on public.site_webhook_log for select using (public.shai_equipe());

-- ───── collabs (influenciadoras) ─────
create table if not exists public.collabs (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  instagram text,
  cupom text not null unique,         -- igual ao cupom criado na Nuvemshop (maiúsculas)
  desconto_pct numeric(5,2),
  comissao_pct numeric(5,2) not null default 10,
  ativo boolean not null default true,
  inicio date,
  observacao text,
  criado_em timestamptz not null default now()
);
alter table public.collabs enable row level security;
create policy collabs_donos on public.collabs for all using (public.shai_equipe()) with check (public.shai_equipe());

-- ───── clientes do site (para medir cliente nova e recompra por collab) ─────
alter table public.clientes
  add column if not exists email text,
  add column if not exists cidade text,
  add column if not exists uf text,
  add column if not exists cupom_origem text;   -- cupom da 1ª compra no site

-- funções de gatilho não são chamáveis de fora; enfileirar só por quem está logado
revoke execute on function public.site_enfileirar(uuid, text) from public, anon;
revoke execute on function public.site_trg_estoque(), public.site_trg_produto(), public.site_trg_variacao() from public, anon, authenticated;
grant execute on function public.site_enfileirar(uuid, text) to authenticated;

-- (02/11, depois) Pedidos do site são do setor do site (app Shai Site), não do CD.
drop policy if exists site_pedidos_cd_editar on public.site_pedidos;
drop policy if exists site_pedidos_leitura on public.site_pedidos;
create policy site_pedidos_leitura on public.site_pedidos for select using (public.shai_site());
create policy site_pedidos_editar on public.site_pedidos for update using (public.shai_site()) with check (public.shai_site());
create policy shai_site_ler on public.clientes for select using (public.shai_site());
drop policy if exists site_fila_ler on public.site_fila;
create policy site_fila_ler on public.site_fila for select using (public.shai_site());
