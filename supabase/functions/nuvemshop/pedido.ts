// Pedidos da Nuvemshop → Supabase (usado pela rota ?acao=webhook da função nuvemshop). Pedido criado/pago/cancelado/enviado cai aqui.
// Confere a assinatura (x-linkedstore-hmac-sha256 = HMAC-SHA256 do corpo cru com o client_secret),
// grava o aviso cru em site_webhook_log e responde 200 na hora (a Nuvemshop exige resposta em 3 s);
// o processamento roda depois. A Nuvemshop reenvia, manda fora de ordem e duplicado: por isso sempre
// relemos o pedido inteiro na API e tudo aqui é idempotente (pode rodar 10 vezes, o resultado é o mesmo).
// Pedido pago → baixa o estoque do local Site, grava cliente, e refaz o dia do Site em vendas/fechamento_dia/
// vendas_itens (é o que o Manager e a TV leem). Cancelado → devolve a peça ao estoque do Site.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const PAGOS = ['pago', 'separado', 'enviado', 'entregue'];

export async function hmacHex(segredo: string, corpo: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(corpo)));
  return { hex: [...sig].map(b => b.toString(16).padStart(2, '0')).join(''), b64: btoa(String.fromCharCode(...sig)) };
}

function diaSP(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
}
const num = (v: unknown) => Number(v || 0) || 0;
function telefone(s: string | null | undefined): string | null {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return /^[0-9]{10,11}$/.test(d) ? d : null;
}
function forma(o: any): string {
  const m = String(o.payment_details?.method || o.gateway_name || o.gateway || '').toLowerCase();
  if (m.includes('pix')) return 'pix';
  if (m.includes('boleto') || m.includes('ticket')) return 'boleto';
  if (m.includes('credit') || m.includes('card') || m.includes('cart')) return 'cartao';
  return m || 'desconhecida';
}

async function nuvemGet(cfg: any, path: string) {
  for (let t = 0; t < 5; t++) {
    const r = await fetch(`https://api.nuvemshop.com.br/v1/${cfg.store_id}${path}`, {
      headers: { 'Authentication': `bearer ${cfg.access_token}`, 'User-Agent': 'Shai Sistema (https://shaiinbox.netlify.app)' },
    });
    if (r.status === 429) { await new Promise(res => setTimeout(res, 1500 * (t + 1))); continue; }
    if (!r.ok) throw new Error(`Nuvemshop GET ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  throw new Error('Nuvemshop ocupada (429)');
}

// ---------------- pedido ----------------
export async function processarPedido(sb: SupabaseClient, cfg: any, o: any) {
  const { data: antes } = await sb.from('site_pedidos').select('*').eq('nuvemshop_id', o.id).maybeSingle();

  const cancelado = o.status === 'cancelled' || ['voided', 'refunded'].includes(o.payment_status);
  const pago = o.payment_status === 'paid';
  const despachado = ['shipped', 'fulfilled', 'delivered'].includes(String(o.shipping_status || ''));
  let status = 'aberto';
  if (cancelado) status = 'cancelado';
  else if (pago) {
    status = antes && PAGOS.includes(antes.status) ? antes.status : 'pago'; // não desfaz o andamento do CD
    if (despachado && !['enviado', 'entregue'].includes(status)) status = 'enviado';
  }

  // itens: liga cada linha à nossa variação pelo id da Nuvemshop (ou pelo SKU)
  const variantIds = (o.products || []).map((it: any) => Number(it.variant_id)).filter(Boolean);
  const skus = (o.products || []).map((it: any) => String(it.sku || '')).filter(Boolean);
  const { data: vars } = await sb.from('produto_variacoes')
    .select('id, sku, cor, tamanho, nuvemshop_variant_id, produto_id, produtos(codigo, custo, preco)')
    .or(`nuvemshop_variant_id.in.(${variantIds.join(',') || 0}),sku.in.(${skus.map((s: string) => `"${s}"`).join(',') || '""'})`);
  const acha = (it: any) => (vars || []).find((v: any) => Number(v.nuvemshop_variant_id) === Number(it.variant_id)) || (vars || []).find((v: any) => v.sku && v.sku === String(it.sku || ''));
  const itens = (o.products || []).map((it: any) => {
    const v: any = acha(it);
    const valores = Array.isArray(it.variant_values) ? it.variant_values : [];
    return {
      variacao_id: v?.id || null, variant_id: Number(it.variant_id) || null, sku: it.sku || null,
      codigo: v?.produtos?.codigo != null ? String(v.produtos.codigo) : (it.sku || null),
      descricao: String(it.name || '').replace(/\s*\(.*\)\s*$/, ''),
      cor: v?.cor || valores[0] || null, tamanho: v?.tamanho || valores[1] || null,
      qtd: num(it.quantity), valor: num(it.price), custo: v?.produtos?.custo ?? null, preco_tabela: v?.produtos?.preco ?? null,
    };
  });

  const end = o.shipping_address || {};
  const cupom = Array.isArray(o.coupon) && o.coupon.length ? String(o.coupon[0].code || '').toUpperCase()
    : (o.promotional_discount?.coupon || null);
  const dataPedido = diaSP(o.paid_at || o.created_at);
  const linha: any = {
    nuvemshop_id: o.id,
    numero: String(o.number ?? o.id),
    data: dataPedido,
    criado_em: o.created_at,
    status,
    cliente_nome: o.customer?.name || o.contact_name || end.name || null,
    cliente_whatsapp: telefone(o.customer?.phone || o.contact_phone || end.phone),
    cliente_email: o.customer?.email || o.contact_email || null,
    cliente_cpf: String(o.customer?.identification || o.contact_identification || '').replace(/\D/g, '') || null,
    cliente_cidade: end.city || o.billing_city || null,
    cliente_uf: end.province || o.billing_province || null,
    endereco: o.shipping_address || null,
    envio_metodo: o.shipping_option || o.shipping || null,
    // retirada na loja: a Nuvemshop marca shipping_pickup_type = 'pickup' e manda o nome do ponto
    retirada: o.shipping_pickup_type === 'pickup' ? (o.shipping_store_branch_name || o.shipping_option || 'Loja') : null,
    cupom,
    subtotal: num(o.subtotal),
    desconto: num(o.discount) + num(o.discount_coupon) + num(o.discount_gateway),
    frete: num(o.shipping_cost_customer),
    total: num(o.total),
    forma_pagamento: forma(o),
    itens,
    pago_em: o.paid_at || (pago ? (antes?.pago_em || new Date().toISOString()) : null),
    cancelado_em: cancelado ? (o.cancelled_at || antes?.cancelado_em || new Date().toISOString()) : null,
    atualizado_em: new Date().toISOString(),
  };
  if (despachado && !antes?.rastreio && o.shipping_tracking_number) linha.rastreio = o.shipping_tracking_number;
  const { data: ped, error } = await sb.from('site_pedidos').upsert(linha, { onConflict: 'nuvemshop_id' }).select().single();
  if (error) throw error;

  // estoque do local Site: baixa quando paga, devolve quando cancela (uma vez só, pelo estoque_baixado)
  // a trava é o próprio update condicional: se dois avisos chegam juntos, só um consegue virar a flag
  const virar = async (de: boolean) => {
    const { data } = await sb.from('site_pedidos').update({ estoque_baixado: !de }).eq('id', ped.id).eq('estoque_baixado', de).select('id');
    return !!data?.length;
  };
  const mover = async (sinal: number, tipo: string) => {
    const movs = itens.filter((i: any) => i.variacao_id && i.qtd > 0)
      .map((i: any) => ({ variacao_id: i.variacao_id, local: 'Site', qtd: sinal * i.qtd, tipo, site_pedido_id: ped.id }));
    if (!movs.length) return;
    const { error: e } = await sb.from('estoque_movimentos').insert(movs);
    if (e) { await sb.from('site_pedidos').update({ estoque_baixado: sinal > 0 }).eq('id', ped.id); throw e; } // desfaz a trava
  };
  const deveBaixar = PAGOS.includes(status);
  if (deveBaixar && !ped.estoque_baixado) {
    if (await virar(false)) await mover(-1, 'venda');
  } else if (status === 'cancelado' && ped.estoque_baixado) {
    if (await virar(true)) await mover(1, 'estorno');
  } else if (status === 'cancelado' || status === 'aberto') {
    // pedido aberto/cancelado sem baixa: a Nuvemshop mexeu no estoque dela; reenviamos o nosso saldo
    const prods = [...new Set((vars || []).map((v: any) => v.produto_id))];
    for (const pid of prods) await sb.rpc('site_enfileirar', { p_produto: pid, p_acao: 'estoque' });
  }

  // cliente (para medir cliente nova e recompra por collab)
  if (deveBaixar && linha.cliente_whatsapp) {
    const { data: cli } = await sb.from('clientes').select('id').eq('telefone', linha.cliente_whatsapp).maybeSingle();
    if (!cli) {
      await sb.from('clientes').insert({
        telefone: linha.cliente_whatsapp, nome: linha.cliente_nome,
        cpf: /^[0-9]{11}$/.test(linha.cliente_cpf || '') ? linha.cliente_cpf : null,
        email: linha.cliente_email, cidade: linha.cliente_cidade, uf: linha.cliente_uf,
        loja_origem: 'Site', cupom_origem: cupom,
      });
    } else {
      await sb.from('clientes').update({ email: linha.cliente_email, cidade: linha.cliente_cidade, uf: linha.cliente_uf, atualizado_em: new Date().toISOString() }).eq('id', cli.id);
    }
  }

  // refaz o(s) dia(s) do Site no Manager
  const dias = new Set([dataPedido]);
  if (antes?.data && antes.data !== dataPedido) dias.add(antes.data);
  for (const d of dias) await refazerDia(sb, d);
}

// O Site no Manager: uma linha em vendas por dia (sem vendedora), formas de pagamento em fechamento_dia
// e as peças em vendas_itens. Faturamento = mercadoria (subtotal − desconto), sem o frete.
export async function refazerDia(sb: SupabaseClient, dia: string) {
  const { data: peds } = await sb.from('site_pedidos').select('*').eq('data', dia).in('status', PAGOS);
  const lista = peds || [];
  const merc = (p: any) => Math.max(0, num(p.subtotal) - num(p.desconto));
  const total = Math.round(lista.reduce((s, p) => s + merc(p), 0) * 100) / 100;
  const por = (f: (p: any) => boolean) => Math.round(lista.filter(f).reduce((s, p) => s + merc(p), 0) * 100) / 100;

  await sb.from('vendas').delete().eq('loja', 'Site').eq('data_venda', dia);
  if (lista.length) await sb.from('vendas').insert({ loja: 'Site', valor: total, data_venda: dia, descricao: `Site — ${lista.length} pedido${lista.length > 1 ? 's' : ''}` });

  if (lista.length) {
    await sb.from('fechamento_dia').upsert({
      loja: 'Site', data_fechamento: dia, total_loja: total,
      total_pix: por(p => p.forma_pagamento === 'pix'),
      total_cartao: por(p => p.forma_pagamento !== 'pix'),
      total_dinheiro: 0, total_crediario: 0,
    }, { onConflict: 'loja,data_fechamento' });
  } else {
    await sb.from('fechamento_dia').delete().eq('loja', 'Site').eq('data_fechamento', dia);
  }

  await sb.from('vendas_itens').delete().eq('origem', 'nuvemshop').eq('loja', 'Site').eq('data', dia);
  const linhas: any[] = [];
  for (const p of lista) {
    const hora = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(p.pago_em || p.criado_em || Date.now()));
    for (const i of (p.itens || []) as any[]) linhas.push({
      loja: 'Site', origem: 'nuvemshop', data: dia, hora, venda_ref: String(p.nuvemshop_id), vendedora: null,
      codigo: i.codigo, descricao: [i.descricao, i.cor, i.tamanho].filter(Boolean).join(' · '),
      quantidade: i.qtd, valor: i.valor * i.qtd, valor_tabela: i.preco_tabela != null ? Number(i.preco_tabela) * i.qtd : null,
      desconto: 0, custo: i.custo != null ? Number(i.custo) * i.qtd : null, numero_pedido: p.numero, cliente: p.cliente_nome,
    });
  }
  if (linhas.length) await sb.from('vendas_itens').insert(linhas);
}

export async function processar(sb: SupabaseClient, cfg: any, logId: number, ev: any) {
  try {
    const evento = String(ev.event || '');
    if (evento === 'app/uninstalled') {
      await sb.from('nuvemshop_config').update({ access_token: null }).eq('id', 1);
    } else if (evento.startsWith('order/')) {
      const o = await nuvemGet(cfg, `/orders/${ev.id}`);
      await processarPedido(sb, cfg, o);
    }
    await sb.from('site_webhook_log').update({ processado_em: new Date().toISOString(), erro: null }).eq('id', logId);
  } catch (e: any) {
    await sb.from('site_webhook_log').update({ erro: String(e?.message || e).slice(0, 500) }).eq('id', logId);
  }
}

