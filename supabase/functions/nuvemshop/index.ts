// Ponte Supabase → Nuvemshop. O Supabase é o dono do cadastro e do estoque; a Nuvemshop só recebe.
// Ações (POST {acao} ou ?acao=):
//   autorizar  — volta da instalação do app na loja (?code=): troca o code pelo token e guarda.
//   status     — conectado? loja, fila pendente/erro.
//   webhooks   — (re)cadastra os webhooks de pedido apontando para ?acao=webhook desta função.
//   webhook    — (Nuvemshop chama) aviso de pedido: confere HMAC, grava log, responde 200 e processa depois (pedido.ts).
//   lgpd_*     — webhooks obrigatórios de privacidade: só registram no log para tratar à mão.
//   sync       — processa a fila site_fila (cron a cada minuto; {produto_id} processa só aquela peça, na hora).
//   enviar     — o site despachou: marca o pedido como enviado na Nuvemshop com o rastreio (avisa a cliente).
// Auth: ?key= igual ao bling_config.sync_secret (cron) ou login @shai.local com papel dono ou site.
// Por isso verify_jwt off. A Nuvemshop limita ~2 req/s (balde de 40): resposta 429 espera e repete.
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { hmacHex, processar } from './pedido.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const resposta = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const pausa = (ms: number) => new Promise(r => setTimeout(r, ms));
const MAX_TENTATIVAS = 5;

// ---------------- cliente da API ----------------
class Nuvem {
  base: string;
  constructor(private cfg: any) { this.base = `https://api.nuvemshop.com.br/v1/${cfg.store_id}`; }
  async req(metodo: string, path: string, corpo?: unknown): Promise<any> {
    for (let tentativa = 0; ; tentativa++) {
      const r = await fetch(this.base + path, {
        method: metodo,
        headers: {
          'Authentication': `bearer ${this.cfg.access_token}`,
          'User-Agent': 'Shai Sistema (https://shaiinbox.netlify.app)',
          'Content-Type': 'application/json',
        },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
      });
      if (r.status === 429 && tentativa < 6) {
        const reset = Number(r.headers.get('x-rate-limit-reset') || 0);
        await pausa(Math.min(Math.max(reset, 1000), 10000));
        continue;
      }
      const txt = await r.text();
      let json: any = null;
      try { json = txt ? JSON.parse(txt) : null; } catch { json = txt; }
      if (!r.ok) {
        const msg = typeof json === 'object' && json ? (json.description || json.message || JSON.stringify(json)) : String(txt);
        const e: any = new Error(`Nuvemshop ${metodo} ${path} → ${r.status}: ${msg}`.slice(0, 500));
        e.status = r.status;
        throw e;
      }
      await pausa(450);
      return json;
    }
  }
}

const pt = (s: string) => ({ pt: s });
function descricaoHtml(txt: string | null): string {
  if (!txt) return '';
  if (/<\w+[^>]*>/.test(txt)) return txt; // já é HTML
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return txt.split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

// ---------------- categorias (criadas na Nuvemshop pelo nome do cadastro) ----------------
async function categoriaId(nv: Nuvem, cache: Map<string, number>, nome: string | null): Promise<number | null> {
  if (!nome) return null;
  if (!cache.size) {
    const cats = await nv.req('GET', '/categories?per_page=200&fields=id,name');
    for (const c of cats || []) cache.set(String(c.name?.pt || '').toLowerCase(), c.id);
  }
  const k = nome.toLowerCase();
  if (!cache.has(k)) {
    const c = await nv.req('POST', '/categories', { name: pt(nome) });
    cache.set(k, c.id);
  }
  return cache.get(k)!;
}

// ---------------- dados de uma peça ----------------
async function carregarPeca(sb: SupabaseClient, produtoId: string) {
  const { data: p, error } = await sb.from('produtos').select('*').eq('id', produtoId).single();
  if (error || !p) throw new Error('peça não encontrada');
  const { data: vars } = await sb.from('produto_variacoes').select('*').eq('produto_id', produtoId).order('cor').order('tamanho');
  const { data: est } = await sb.from('v_estoque').select('variacao_id, site').eq('produto_id', produtoId);
  const { data: fotos } = await sb.from('produto_fotos').select('*').eq('produto_id', produtoId).order('posicao');
  // peças de pedidos ainda não pagos: a Nuvemshop já tirou do estoque dela, nós ainda não
  const { data: abertos } = await sb.from('site_pedidos').select('itens').eq('status', 'aberto').eq('estoque_baixado', false);
  const reservado = new Map<number, number>();
  for (const o of abertos || []) for (const it of (o.itens || []) as any[]) {
    if (it.variant_id) reservado.set(Number(it.variant_id), (reservado.get(Number(it.variant_id)) || 0) + Number(it.qtd || 0));
  }
  const saldo = new Map<string, number>((est || []).map((e: any) => [e.variacao_id, e.site]));
  const estoqueDe = (v: any) => Math.max(0, (saldo.get(v.id) || 0) - (v.nuvemshop_variant_id ? (reservado.get(Number(v.nuvemshop_variant_id)) || 0) : 0));
  return { p, vars: vars || [], fotos: fotos || [], estoqueDe };
}

const precoDe = (p: any) => Number(p.site_preco ?? p.preco ?? 0).toFixed(2);
const pesoKg = (p: any, cfg: any) => ((p.peso_g || cfg.peso_padrao_g || 400) / 1000).toFixed(3);

// ---------------- envio de uma peça (produto + variações + estoque) ----------------
async function syncProduto(sb: SupabaseClient, nv: Nuvem, cfg: any, cats: Map<string, number>, produtoId: string) {
  const { p, vars, fotos, estoqueDe } = await carregarPeca(sb, produtoId);
  if (p.site_status === 'fora') {
    await sb.from('produtos').update({ site_status: 'rascunho' }).eq('id', p.id);
    p.site_status = 'rascunho';
  }
  const publicado = p.site_status === 'publicado';
  const nome = p.site_nome || p.nome;
  const catId = await categoriaId(nv, cats, p.categoria);
  const base: any = {
    name: pt(nome),
    description: pt(descricaoHtml(p.site_descricao)),
    published: publicado,
    categories: catId ? [catId] : [],
  };
  const varianteDe = (v: any) => ({
    price: precoDe(p),
    stock: estoqueDe(v),
    stock_management: true,
    sku: v.sku,
    barcode: v.ean || undefined,
    weight: pesoKg(p, cfg),
    cost: p.custo != null ? Number(p.custo).toFixed(2) : undefined,
  });

  let nid = p.nuvemshop_id as number | null;
  if (nid) {
    try { await nv.req('PUT', `/products/${nid}`, base); }
    catch (e: any) {
      if (e.status !== 404) throw e;
      // apagaram a peça lá: recria do zero
      nid = null;
      await sb.from('produto_variacoes').update({ nuvemshop_variant_id: null }).eq('produto_id', p.id);
      await sb.from('produto_fotos').update({ nuvemshop_image_id: null }).eq('produto_id', p.id);
      vars.forEach((v: any) => v.nuvemshop_variant_id = null);
      fotos.forEach((f: any) => f.nuvemshop_image_id = null);
    }
  }
  if (!nid) {
    const criado = await nv.req('POST', '/products', {
      ...base,
      attributes: [pt('Cor'), pt('Tamanho')],
      variants: vars.map((v: any) => ({ ...varianteDe(v), values: [pt(v.cor), pt(v.tamanho)] })),
    });
    nid = criado.id;
    await sb.from('produtos').update({ nuvemshop_id: nid }).eq('id', p.id);
    for (const cv of criado.variants || []) {
      const v = vars.find((x: any) => x.sku === cv.sku);
      if (v) { v.nuvemshop_variant_id = cv.id; await sb.from('produto_variacoes').update({ nuvemshop_variant_id: cv.id }).eq('id', v.id); }
    }
    if (fotos.length) await sb.rpc('site_enfileirar', { p_produto: p.id, p_acao: 'fotos' });
  } else {
    for (const v of vars) {
      if (v.nuvemshop_variant_id) {
        try { await nv.req('PUT', `/products/${nid}/variants/${v.nuvemshop_variant_id}`, varianteDe(v)); continue; }
        catch (e: any) { if (e.status !== 404) throw e; }
      }
      const cv = await nv.req('POST', `/products/${nid}/variants`, { ...varianteDe(v), values: [pt(v.cor), pt(v.tamanho)] });
      await sb.from('produto_variacoes').update({ nuvemshop_variant_id: cv.id }).eq('id', v.id);
    }
  }
  await sb.from('produtos').update({
    site_atualizado_em: new Date().toISOString(), site_erro: null,
    ...(publicado && !p.site_publicado_em ? { site_publicado_em: new Date().toISOString() } : {}),
  }).eq('id', p.id);
}

// ---------------- só o estoque (o mais frequente: distribuição, venda, ajuste) ----------------
async function syncEstoque(sb: SupabaseClient, nv: Nuvem, cfg: any, cats: Map<string, number>, produtoId: string) {
  const { p, vars, estoqueDe } = await carregarPeca(sb, produtoId);
  if (!p.nuvemshop_id || vars.some((v: any) => !v.nuvemshop_variant_id)) return syncProduto(sb, nv, cfg, cats, produtoId);
  for (const v of vars) {
    await nv.req('PUT', `/products/${p.nuvemshop_id}/variants/${v.nuvemshop_variant_id}`, { stock: estoqueDe(v) });
  }
}

// ---------------- fotos (ordem, capa e foto de cada cor) ----------------
async function syncFotos(sb: SupabaseClient, nv: Nuvem, cfg: any, cats: Map<string, number>, produtoId: string) {
  let { p, vars, fotos } = await carregarPeca(sb, produtoId);
  if (!p.nuvemshop_id) { await syncProduto(sb, nv, cfg, cats, produtoId); ({ p, vars, fotos } = await carregarPeca(sb, produtoId)); }
  const nid = p.nuvemshop_id;
  const remotas: any[] = await nv.req('GET', `/products/${nid}/images`) || [];
  const nossas = new Set(fotos.map((f: any) => Number(f.nuvemshop_image_id)).filter(Boolean));
  for (const r of remotas) if (!nossas.has(Number(r.id))) await nv.req('DELETE', `/products/${nid}/images/${r.id}`);
  const remotasIds = new Set(remotas.map(r => Number(r.id)));
  for (let i = 0; i < fotos.length; i++) {
    const f = fotos[i];
    const position = i + 1;
    if (f.nuvemshop_image_id && remotasIds.has(Number(f.nuvemshop_image_id))) {
      const atual = remotas.find(r => Number(r.id) === Number(f.nuvemshop_image_id));
      if (atual?.position !== position) await nv.req('PUT', `/products/${nid}/images/${f.nuvemshop_image_id}`, { position });
    } else {
      const img = await nv.req('POST', `/products/${nid}/images`, { src: f.url, position });
      f.nuvemshop_image_id = img.id;
      await sb.from('produto_fotos').update({ nuvemshop_image_id: img.id }).eq('id', f.id);
    }
  }
  // foto da cor: a 1ª foto marcada com aquela cor vira a imagem das variações dessa cor
  for (const v of vars) {
    if (!v.nuvemshop_variant_id) continue;
    const f = fotos.find((x: any) => x.cor && x.cor === v.cor);
    if (f?.nuvemshop_image_id) await nv.req('PUT', `/products/${nid}/variants/${v.nuvemshop_variant_id}`, { image_id: f.nuvemshop_image_id });
  }
}

// ---------------- fila ----------------
async function processarFila(sb: SupabaseClient, cfg: any, produtoId?: string) {
  const nv = new Nuvem(cfg);
  const cats = new Map<string, number>();
  const inicio = Date.now();
  let q = sb.from('site_fila').select('*').eq('status', 'pendente').order('id').limit(40);
  if (produtoId) q = q.eq('produto_id', produtoId);
  const { data: itens } = await q;
  // por peça: produto antes de fotos; se o produto vai ser enviado, o estoque vai junto
  const ordem: Record<string, number> = { produto: 0, fotos: 1, estoque: 2 };
  const lista = (itens || []).sort((a: any, b: any) => ordem[a.acao] - ordem[b.acao]);
  const produtoEnviado = new Set<string>();
  const out: any[] = [];
  for (const it of lista) {
    if (Date.now() - inicio > 100000) break; // deixa o resto para a próxima rodada
    try {
      if (it.acao === 'estoque' && produtoEnviado.has(it.produto_id)) { /* já foi com o produto */ }
      else if (it.acao === 'produto') { await syncProduto(sb, nv, cfg, cats, it.produto_id); produtoEnviado.add(it.produto_id); }
      else if (it.acao === 'estoque') await syncEstoque(sb, nv, cfg, cats, it.produto_id);
      else if (it.acao === 'fotos') await syncFotos(sb, nv, cfg, cats, it.produto_id);
      await sb.from('site_fila').update({ status: 'ok', processado_em: new Date().toISOString(), tentativas: it.tentativas + 1, erro: null }).eq('id', it.id);
      out.push({ id: it.id, acao: it.acao, ok: true });
    } catch (e: any) {
      const tent = it.tentativas + 1;
      const msg = String(e?.message || e).slice(0, 500);
      // passou do limite: sai da fila de pendentes (fica 'erro' para aparecer no app) e a peça guarda o motivo
      await sb.from('site_fila').update({ status: tent >= MAX_TENTATIVAS ? 'erro' : 'pendente', tentativas: tent, erro: msg, processado_em: new Date().toISOString() }).eq('id', it.id);
      await sb.from('produtos').update({ site_erro: msg }).eq('id', it.produto_id);
      out.push({ id: it.id, acao: it.acao, ok: false, erro: msg });
    }
  }
  return out;
}

// ---------------- autorização (instalação do app na loja) ----------------
async function autorizar(sb: SupabaseClient, cfg: any, code: string) {
  const r = await fetch('https://www.tiendanube.com/apps/authorize/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.client_id, client_secret: cfg.client_secret, grant_type: 'authorization_code', code }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('a Nuvemshop recusou o código: ' + JSON.stringify(j).slice(0, 300));
  await sb.from('nuvemshop_config').update({ access_token: j.access_token, store_id: j.user_id, autorizado_em: new Date().toISOString() }).eq('id', 1);
  return j.user_id;
}

const pagina = (titulo: string, texto: string) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title>
  <body style="font-family:system-ui;background:#f4f3f1;color:#1d1915;display:grid;place-items:center;min-height:100vh;margin:0">
  <div style="background:#fff;border:1px solid #e3e0db;border-radius:8px;padding:28px;max-width:420px;text-align:center">
  <h2 style="margin:0 0 8px;color:#5c3d28">${titulo}</h2><p style="margin:0;color:#57504a">${texto}</p></div></body>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

// ---------------- webhooks ----------------
const EVENTOS = ['order/created', 'order/updated', 'order/paid', 'order/cancelled', 'order/fulfilled'];
async function cadastrarWebhooks(sb: SupabaseClient, cfg: any) {
  const nv = new Nuvem(cfg);
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/nuvemshop?acao=webhook`;
  const atuais: any[] = await nv.req('GET', '/webhooks') || [];
  for (const w of atuais) if (String(w.url || '').includes('/functions/v1/nuvemshop')) await nv.req('DELETE', `/webhooks/${w.id}`);
  for (const event of EVENTOS) await nv.req('POST', '/webhooks', { event, url });
  await sb.from('nuvemshop_config').update({ webhooks_em: new Date().toISOString() }).eq('id', 1);
  return EVENTOS;
}

// ---------------- entrada ----------------
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: cfg } = await sb.from('nuvemshop_config').select('*').eq('id', 1).single();
  const acaoUrl = url.searchParams.get('acao') || '';

  // avisos da Nuvemshop: o HMAC é do corpo cru, então lê antes de qualquer parse
  if (req.method === 'POST' && (acaoUrl === 'webhook' || acaoUrl.startsWith('lgpd_'))) {
    const cru = await req.text();
    if (!cfg?.client_secret) return new Response('não configurado', { status: 503 });
    const assinatura = (req.headers.get('x-linkedstore-hmac-sha256') || '').trim();
    const { hex, b64 } = await hmacHex(cfg.client_secret, cru);
    let ev: any = {};
    try { ev = JSON.parse(cru); } catch { /* corpo inválido */ }
    if (!assinatura || (assinatura.toLowerCase() !== hex && assinatura !== b64)) {
      await sb.from('site_webhook_log').insert({ evento: ev.event ?? acaoUrl, nuvemshop_id: ev.id ?? null, corpo: ev, erro: 'assinatura HMAC inválida' });
      return new Response('assinatura inválida', { status: 401 });
    }
    if (acaoUrl.startsWith('lgpd_')) {
      await sb.from('site_webhook_log').insert({ evento: acaoUrl, corpo: ev, erro: 'LGPD: tratar à mão' });
      return new Response('ok');
    }
    if (cfg.store_id && ev.store_id && Number(ev.store_id) !== Number(cfg.store_id)) return new Response('outra loja');
    const { data: log } = await sb.from('site_webhook_log').insert({ evento: ev.event, nuvemshop_id: ev.id, corpo: ev }).select('id').single();
    EdgeRuntime.waitUntil(processar(sb, cfg, log!.id, ev));
    return new Response('ok');
  }

  // refazer avisos que deram erro: ?acao=reprocessar&key=sync_secret (cron/donos)
  if (acaoUrl === 'reprocessar') {
    const { data: bc } = await sb.from('bling_config').select('sync_secret').eq('id', 1).single();
    if (!bc?.sync_secret || url.searchParams.get('key') !== bc.sync_secret) return resposta({ erro: 'não autorizado' }, 401);
    const { data: pend } = await sb.from('site_webhook_log').select('*').is('processado_em', null).is('erro', null).like('evento', 'order/%').order('id').limit(30);
    const { data: comErro } = await sb.from('site_webhook_log').select('*').is('processado_em', null).not('erro', 'is', null).like('evento', 'order/%').order('id').limit(30);
    const todos = [...(pend || []), ...(comErro || []).filter((l: any) => !String(l.erro).includes('HMAC'))];
    for (const l of todos) await processar(sb, cfg, l.id, l.corpo);
    return resposta({ reprocessados: todos.length });
  }

  let corpo: any = {};
  if (req.method === 'POST') corpo = await req.json().catch(() => ({}));
  const acao = corpo.acao || url.searchParams.get('acao') || '';

  // volta da instalação: quem chega aqui é o navegador do Arthur, sem login; o code só vale com o nosso secret
  if (acao === 'autorizar' || (req.method === 'GET' && url.searchParams.get('code'))) {
    const code = url.searchParams.get('code') || '';
    if (!cfg?.client_id || !cfg?.client_secret) return pagina('Falta configurar', 'Cadastre o client id e o client secret do aplicativo antes de instalar.');
    try {
      const loja = await autorizar(sb, { ...cfg }, code);
      const { data: cfg2 } = await sb.from('nuvemshop_config').select('*').eq('id', 1).single();
      let extra = '';
      try { await cadastrarWebhooks(sb, cfg2); extra = ' Os pedidos já vão chegar no sistema.'; }
      catch (e: any) { extra = ' (Webhooks não cadastrados: ' + String(e.message).slice(0, 120) + ')'; }
      return pagina('Loja conectada', `A Nuvemshop (loja ${loja}) está ligada ao sistema da Shai.${extra}`);
    } catch (e: any) {
      return pagina('Não deu certo', String(e.message || e));
    }
  }

  // quem está chamando
  let papel = 'cron';
  const key = url.searchParams.get('key');
  if (!(key && key === (await sb.from('bling_config').select('sync_secret').eq('id', 1).single()).data?.sync_secret)) {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data } = jwt ? await sb.auth.getUser(jwt) : { data: { user: null } };
    const user = data?.user;
    if (!user?.email?.endsWith('@shai.local')) return resposta({ erro: 'não autorizado' }, 401);
    papel = user.app_metadata?.papel || '';
    if (!['dono', 'site'].includes(papel)) return resposta({ erro: 'login sem acesso ao site' }, 403);
  }

  const conectado = !!(cfg?.access_token && cfg?.store_id);
  try {
    if (acao === 'status') {
      const { count: pendentes } = await sb.from('site_fila').select('id', { count: 'exact', head: true }).eq('status', 'pendente');
      const { count: erros } = await sb.from('site_fila').select('id', { count: 'exact', head: true }).eq('status', 'erro');
      return resposta({ conectado, loja: cfg?.store_id || null, webhooks_em: cfg?.webhooks_em || null, configurado: !!cfg?.client_id, pendentes, erros });
    }
    if (!conectado) return resposta({ erro: 'Nuvemshop ainda não conectada (instale o aplicativo na loja)' }, 409);

    if (acao === 'webhooks') {
      if (papel !== 'dono' && papel !== 'cron') return resposta({ erro: 'só os donos' }, 403);
      return resposta({ ok: true, eventos: await cadastrarWebhooks(sb, cfg) });
    }
    if (acao === 'sync') {
      const produtoId = corpo.produto_id || url.searchParams.get('produto_id') || undefined;
      if (corpo.refazer && produtoId) { // botão "enviar de novo" no app: reabre o que deu erro
        await sb.from('site_fila').update({ status: 'pendente', tentativas: 0 }).eq('produto_id', produtoId).eq('status', 'erro');
      }
      return resposta({ ok: true, processados: await processarFila(sb, cfg, produtoId) });
    }
    if (acao === 'enviar') {
      if (papel === 'cron') return resposta({ erro: 'só pelo app' }, 403);
      const { data: ped } = await sb.from('site_pedidos').select('*').eq('id', corpo.pedido_id).single();
      if (!ped) return resposta({ erro: 'pedido não encontrado' }, 404);
      const rastreio = String(corpo.rastreio || '').trim();
      const nv = new Nuvem(cfg);
      await nv.req('POST', `/orders/${ped.nuvemshop_id}/fulfill`, {
        shipping_tracking_number: rastreio || undefined,
        shipping_tracking_url: corpo.rastreio_url || undefined,
        notify_customer: true,
      });
      await sb.from('site_pedidos').update({ status: 'enviado', rastreio: rastreio || null, enviado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() }).eq('id', ped.id);
      return resposta({ ok: true });
    }
    return resposta({ erro: 'ação desconhecida' }, 400);
  } catch (e: any) {
    return resposta({ erro: String(e?.message || e) }, 500);
  }
});
