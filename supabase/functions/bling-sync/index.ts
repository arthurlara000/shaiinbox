// Sincroniza pedidos de venda do Bling com o Shai Manager, separando por loja (pedido.loja.id).
// Grava o fechamento do dia (fechamento_dia, fechamento_vendedoras, vendas) e as peças (vendas_itens).
// Auth própria: exige ?key= igual ao sync_secret da bling_config (por isso verify_jwt off).
// Parâmetros: ?de=YYYY-MM-DD&ate=YYYY-MM-DD (sem: ontem + hoje em São Paulo); ?dry=1 não grava nada;
// ?numeros=1 só preenche o nº do pedido e o cliente nas peças já gravadas do período.
// enable-jwt: 1 vai no refresh e, quando o token já é JWT, nas chamadas à API (migração JWT do Bling).
// O Bling limita 3 requisições/s: chamada recusada é repetida; se um pedido não puder ser lido,
// nada é gravado (gravar o dia incompleto apagaria um fechamento correto).
// PDV da Shai: pagamento com VALE-TROCA não é faturamento (o dinheiro entrou na venda original) nem
// conta para a vendedora; devolução em dinheiro feita no PDV (pdv_trocas) sai do fechamento do dia dela.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const API = 'https://api.bling.com.br/Api/v3';
const pausa = (ms: number) => new Promise(r => setTimeout(r, ms));
const ehJwt = (t?: string) => !!t && t.split('.').length === 3;
const norm = (s: string) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const primeiroNome = (s: string) => norm(s).split(/\s+/)[0] || '';
const r2 = (n: number) => Math.round(n * 100) / 100;

function hojeSP(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function classificaForma(descricao: string, tipo: number): string {
  const d = norm(descricao);
  if (/vale/.test(d)) return 'vale';
  if (/pix/.test(d)) return 'pix';
  if (/dinheiro|especie/.test(d)) return 'dinheiro';
  if (/crediario|carne|fiado|prazo/.test(d)) return 'crediario';
  if (/cart|credito|debito|visa|master|elo|maquin/.test(d)) return 'cartao';
  if (tipo === 1) return 'dinheiro';
  if (tipo === 3 || tipo === 4) return 'cartao';
  if (tipo === 17) return 'pix';
  return 'desconhecida';
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: cfg } = await sb.from('bling_config').select('*').eq('id', 1).single();
  if (!cfg?.sync_secret || url.searchParams.get('key') !== cfg.sync_secret) {
    return new Response(JSON.stringify({ erro: 'nao autorizado' }), { status: 401 });
  }
  const dry = url.searchParams.get('dry') === '1';

  const hoje = hojeSP();
  let de = url.searchParams.get('de');
  let ate = url.searchParams.get('ate');
  if (de && !ate) ate = de;
  if (!de) {
    ate = hoje;
    const d = new Date(hoje + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    de = d.toISOString().slice(0, 10);
  }

  // ----- token: o refresh_token do Bling rotaciona e é compartilhado com a função pdv.
  // Se outro processo renovar junto, o nosso refresh falha: espera e relê o token novo.
  let access = '';
  for (let tentativa = 0; tentativa < 4 && !access; tentativa++) {
    const { data: tk } = await sb.from('bling_tokens').select('*').eq('id', 1).single();
    if (!tk?.refresh_token) return new Response(JSON.stringify({ erro: 'sem tokens — autorize o app primeiro' }), { status: 500 });
    if (tk.access_token && tk.expires_at && new Date(tk.expires_at) > new Date(Date.now() + 120000)) { access = tk.access_token; break; }
    const basic = btoa(`${cfg.client_id}:${cfg.client_secret}`);
    const r = await fetch(`${API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basic}`, 'Accept': '1.0', 'enable-jwt': '1' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tk.refresh_token }),
    });
    const nt = await r.json().catch(() => ({}));
    if (r.ok && nt.access_token) {
      access = nt.access_token;
      await sb.from('bling_tokens').upsert({ id: 1, access_token: nt.access_token, refresh_token: nt.refresh_token ?? tk.refresh_token, expires_at: new Date(Date.now() + ((nt.expires_in ?? 21600) - 300) * 1000).toISOString(), updated_at: new Date().toISOString() });
    } else await pausa(1500 * (tentativa + 1));
  }
  if (!access) return new Response(JSON.stringify({ erro: 'falha no refresh do token do Bling' }), { status: 500 });
  const hdr: Record<string, string> = { 'Authorization': `Bearer ${access}`, 'Accept': 'application/json' };
  if (ehJwt(access)) hdr['enable-jwt'] = '1';
  const blingGet = async (path: string) => {
    for (let tentativa = 0; ; tentativa++) {
      await pausa(tentativa === 0 ? 400 : 1000 * 2 ** tentativa);
      const r = await fetch(API + path, { headers: hdr });
      const json = await r.json().catch(() => ({}));
      if (r.ok || tentativa >= 4 || (r.status !== 429 && r.status < 500)) return { ok: r.ok, status: r.status, json };
    }
  };

  // ----- ?numeros=1: só preenche nº do pedido e cliente nas peças já gravadas (fechamentos não mudam) -----
  if (url.searchParams.get('numeros') === '1') {
    let pedidos = 0, pecas = 0;
    for (let pag = 1; pag < 100; pag++) {
      const rl = await blingGet(`/pedidos/vendas?dataInicial=${de}&dataFinal=${ate}&limite=100&pagina=${pag}`);
      if (!rl.ok) return new Response(JSON.stringify({ erro: 'falha ao listar pedidos', status: rl.status, pagina: pag, pedidos, pecas }), { status: 503 });
      const lote: { id: number; numero?: number; contato?: { nome?: string } }[] = rl.json.data || [];
      pedidos += lote.length;
      for (let i = 0; i < lote.length && !dry; i += 25) {
        const rs = await Promise.all(lote.slice(i, i + 25).map(p => sb.from('vendas_itens')
          .update({ numero_pedido: p.numero != null ? String(p.numero) : null, cliente: p.contato?.nome || null }, { count: 'exact' })
          .eq('origem', 'bling').eq('venda_ref', String(p.id))));
        for (const r of rs) pecas += r.count || 0;
      }
      if (lote.length < 100) break;
    }
    return new Response(JSON.stringify({ ok: true, dry, de, ate, pedidos, pecas }), { headers: { 'Content-Type': 'application/json' } });
  }

  // ----- mapas: vendedores e formas de pagamento -----
  const vendedorNome: Record<number, string> = {};
  const rv = await blingGet('/vendedores?limite=100&pagina=1');
  if (rv.ok) for (const v of (rv.json.data || [])) vendedorNome[v.id] = v.contato?.nome || '';
  const nomeDoVendedor = async (id: number | undefined): Promise<string> => {
    if (!id) return '';
    if (id in vendedorNome) return vendedorNome[id];
    const r = await blingGet(`/vendedores/${id}`);
    vendedorNome[id] = r.ok ? (r.json.data?.contato?.nome || '') : '';
    return vendedorNome[id];
  };

  const formaCat: Record<number, string> = {};
  const formaDesc: Record<number, string> = {};
  const rf = await blingGet('/formas-pagamentos?limite=100&pagina=1');
  if (!rf.ok) return new Response(JSON.stringify({ erro: 'formas de pagamento nao lidas, nada gravado', status: rf.status }), { status: 503 });
  for (const f of (rf.json.data || [])) { formaDesc[f.id] = f.descricao || ''; formaCat[f.id] = classificaForma(f.descricao || '', f.tipoPagamento); }
  for (const [id, cat] of Object.entries(cfg.formas_map || {})) formaCat[Number(id)] = String(cat); // override manual

  // ----- lojas e funcionárias -----
  const lojasMap: Record<string, string> = cfg.lojas_map || { '206024907': 'Loja Três Rios', '206006808': 'Loja Areal' };
  const { data: funcs } = await sb.from('funcionarias').select('id, nome, loja');
  const funcDe = (nome: string, loja?: string) => {
    const alvo = primeiroNome(nome);
    if (!alvo) return null;
    return (funcs || []).find(f => primeiroNome(f.nome) === alvo && (!loja || f.loja === loja)) || null;
  };

  const excluir = new Set(String(cfg.situacoes_excluir || '').split(',').map(s => s.trim()).filter(Boolean).map(Number));

  // ----- varre os pedidos do período -----
  type Dia = { formas: Record<string, number>; vendedoras: Record<string, number>; nomes: Record<string, number>; formasBrutas: Record<string, number>; pedidos: number; itens: Record<string, unknown>[]; devolucoes: number };
  const dias: Record<string, Dia> = {}; // chave: loja|data
  const diaDe = (loja: string, d: string): Dia => dias[`${loja}|${d}`] ??= { formas: { dinheiro: 0, pix: 0, cartao: 0, crediario: 0, desconhecida: 0, vale: 0 }, vendedoras: {}, nomes: {}, formasBrutas: {}, pedidos: 0, itens: [], devolucoes: 0 };
  const porLojaId: Record<string, { pedidos: number; total: number }> = {};
  const semLoja: Record<string, { pedidos: number; total: number }> = {}; // por data

  const ids: number[] = [];
  for (let pag = 1; pag < 30; pag++) {
    const rl = await blingGet(`/pedidos/vendas?dataInicial=${de}&dataFinal=${ate}&limite=100&pagina=${pag}`);
    if (!rl.ok) return new Response(JSON.stringify({ erro: 'falha ao listar pedidos, nada gravado', status: rl.status, detalhe: rl.json }), { status: 503 });
    const lote = rl.json.data || [];
    for (const p of lote) ids.push(p.id);
    if (lote.length < 100) break;
  }

  for (const id of ids) {
    const rp = await blingGet(`/pedidos/vendas/${id}`);
    if (!rp.ok) return new Response(JSON.stringify({ erro: 'pedido nao lido, nada gravado', pedido: id, status: rp.status }), { status: 503 });
    const p = rp.json.data;
    if (!p?.data) continue;
    const sit = Number(p.situacao?.id ?? p.situacao?.valor);
    if (excluir.has(sit)) continue;
    const total = Number(p.total) || 0;
    const lojaId = String(p.loja?.id ?? 0);
    porLojaId[lojaId] = { pedidos: (porLojaId[lojaId]?.pedidos || 0) + 1, total: (porLojaId[lojaId]?.total || 0) + total };

    const nomeV = await nomeDoVendedor(p.vendedor?.id);
    // loja do pedido; sem loja => usa a loja da vendedora; sem as duas => fica de fora (registrado no log)
    let loja = lojasMap[lojaId];
    if (!loja) loja = funcDe(nomeV)?.loja;
    if (!loja) {
      semLoja[p.data] = { pedidos: (semLoja[p.data]?.pedidos || 0) + 1, total: (semLoja[p.data]?.total || 0) + total };
      continue;
    }

    const dia = diaDe(loja, p.data);
    dia.pedidos++;
    const parcelas = p.parcelas || [];
    let pagoComVale = 0;
    if (!parcelas.length) dia.formas.crediario += total;
    for (const pc of parcelas) {
      const v = Number(pc.valor) || 0;
      const fpid = pc.formaPagamento?.id;
      const cat = formaCat[fpid] || 'desconhecida';
      dia.formas[cat] = (dia.formas[cat] || 0) + v;
      if (cat === 'vale') pagoComVale += v;
      const rot = `${fpid}:${formaDesc[fpid] || '?'}`;
      dia.formasBrutas[rot] = (dia.formasBrutas[rot] || 0) + v;
    }
    // a parte paga com vale-troca já foi vendida (e creditada) na venda original
    const valorVendedora = Math.max(0, total - pagoComVale);
    const f = funcDe(nomeV, loja);
    if (f) dia.vendedoras[f.id] = (dia.vendedoras[f.id] || 0) + valorVendedora;
    else { const k = nomeV || 'sem vendedor'; dia.nomes[k] = (dia.nomes[k] || 0) + valorVendedora; }

    // peças do pedido (desconto do pedido rateado proporcionalmente entre as peças)
    const itens = p.itens || [];
    const bruto = itens.reduce((s: number, it: Record<string, number>) => s + (Number(it.valor) || 0) * (Number(it.quantidade) || 0), 0);
    const descPedido = p.desconto?.unidade === 'PERCENTUAL' ? bruto * (Number(p.desconto?.valor) || 0) / 100 : (Number(p.desconto?.valor) || 0);
    for (const it of itens) {
      const qtd = Number(it.quantidade) || 0;
      const tabela = (Number(it.valor) || 0) * qtd;
      const descItem = tabela * (Number(it.desconto) || 0) / 100;
      const rateio = bruto > 0 ? descPedido * tabela / bruto : 0;
      dia.itens.push({
        loja, origem: 'bling', data: p.data, venda_ref: String(p.id), vendedora: nomeV || null,
        numero_pedido: p.numero != null ? String(p.numero) : null, cliente: p.contato?.nome || null,
        codigo: it.codigo || null, descricao: it.descricao || null, quantidade: qtd,
        valor_tabela: r2(tabela), desconto: r2(descItem + rateio), valor: r2(tabela - descItem - rateio),
      });
    }
  }

  // ----- devoluções em dinheiro/pix/cartão feitas no PDV: saem do fechamento do dia em que aconteceram -----
  const devolucoesSemDia: unknown[] = [];
  // com comprovante, a venda foi desfeita: o valor também sai da vendedora que vendeu (no dia da devolução)
  const { data: devs } = await sb.from('pdv_trocas').select('loja, data, valor, forma_reembolso, venda_origem').eq('destino', 'dinheiro').gte('data', de).lte('data', ate);
  const origens = [...new Set((devs || []).map(t => t.venda_origem).filter(Boolean))];
  const vendedoraDaVenda: Record<string, string> = {};
  if (origens.length) {
    const { data: vo } = await sb.from('pdv_vendas').select('id, funcionaria_id').in('id', origens);
    for (const v of vo || []) if (v.funcionaria_id) vendedoraDaVenda[v.id] = v.funcionaria_id;
  }
  for (const t of devs || []) {
    const dia = dias[`${t.loja}|${t.data}`];
    if (!dia) { devolucoesSemDia.push(t); continue; }
    const valor = Number(t.valor) || 0;
    const forma = t.forma_reembolso === 'pix' ? 'pix' : t.forma_reembolso === 'cartao' ? 'cartao' : 'dinheiro';
    dia.formas[forma] = (dia.formas[forma] || 0) - valor;
    dia.devolucoes += valor;
    const fid = t.venda_origem ? vendedoraDaVenda[t.venda_origem] : null;
    if (fid) dia.vendedoras[fid] = (dia.vendedoras[fid] || 0) - valor;
  }

  // ----- grava no banco (mesmo formato do app de vendas) -----
  const resumo: Record<string, unknown>[] = [];
  for (const [chave, d] of Object.entries(dias).sort()) {
    if (!d.pedidos) continue;
    const [loja, dataStr] = chave.split('|');
    const total_dinheiro = r2(d.formas.dinheiro), total_pix = r2(d.formas.pix), total_crediario = r2(d.formas.crediario);
    const total_cartao = r2(d.formas.cartao + (d.formas.desconhecida || 0)); // desconhecidas caem em cartão (auditar no log)
    const total_loja = r2(total_dinheiro + total_pix + total_cartao + total_crediario); // vale-troca fica de fora
    resumo.push({ loja, dia: dataStr, pedidos: d.pedidos, pecas: d.itens.length, total_loja, pagoComVale: r2(d.formas.vale || 0), devolucoes: r2(d.devolucoes), formas: d.formas, formasBrutas: d.formasBrutas, semAtribuicao: d.nomes });
    if (dry) continue;
    const { data: fech, error: e1 } = await sb.from('fechamento_dia').upsert(
      { loja, data_fechamento: dataStr, total_loja, total_dinheiro, total_cartao, total_pix, total_crediario },
      { onConflict: 'loja,data_fechamento' },
    ).select().single();
    if (e1 || !fech) { resumo.push({ loja, dia: dataStr, erro: e1?.message }); continue; }
    await sb.from('fechamento_vendedoras').delete().eq('fechamento_id', fech.id);
    const vrows = Object.entries(d.vendedoras).map(([fid, valor]) => ({ fechamento_id: fech.id, funcionaria_id: fid, valor: r2(valor as number) }));
    if (vrows.length) await sb.from('fechamento_vendedoras').insert(vrows);
    await sb.from('vendas').delete().eq('loja', loja).eq('data_venda', dataStr);
    const vendasRows = [
      ...Object.entries(d.vendedoras).map(([fid, valor]) => ({ funcionaria_id: fid, loja, data_venda: dataStr, valor: r2(valor as number), descricao: 'Bling sync' })),
      ...Object.entries(d.nomes).map(([nome, valor]) => ({ funcionaria_id: null, loja, data_venda: dataStr, valor: r2(valor as number), descricao: `Bling: ${nome}` })),
    ];
    if (vendasRows.length) await sb.from('vendas').insert(vendasRows);
    await sb.from('vendas_itens').delete().eq('origem', 'bling').eq('loja', loja).eq('data', dataStr);
    for (let i = 0; i < d.itens.length; i += 500) await sb.from('vendas_itens').insert(d.itens.slice(i, i + 500));
  }

  if (!dry) await sb.from('bling_sync_log').insert({ data_inicial: de, data_final: ate, pedidos: ids.length, detalhes: { resumo, porLojaId, semLoja, devolucoesSemDia, vendedores: vendedorNome, tokenJwt: ehJwt(access) } });
  return new Response(JSON.stringify({ ok: true, dry, de, ate, tokenJwt: ehJwt(access), pedidosEncontrados: ids.length, porLojaId, semLoja, devolucoesSemDia, dias: resumo }, null, 1), { headers: { 'Content-Type': 'application/json' } });
});
