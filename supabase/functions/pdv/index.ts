// PDV da Shai — ponte entre o app vendas/ (o caixa das lojas) e o Bling.
// O Bling é a base: produto, preço, venda, pagamento e estoque. Esta função:
//  - configurar   : confere as permissões do app no Bling e preenche pdv_config (depósitos, formas, Consumidor Final, vendedoras)
//  - catalogo     : espelha produtos (simples + variações) e saldos por depósito em pdv_catalogo
//  - buscar       : procura um código direto no Bling (peça que ainda não está no espelho)
//  - enviar       : manda ao Bling vendas, trocas, cancelamentos e parcelas de crediário recebidas (um item ou a fila toda)
//  - cancelar     : desfaz uma venda no Bling (estorna estoque e contas, situação cancelado)
//  - clientes     : procura clientes já cadastradas no Bling (nome ou CPF)
// Auth: login dos donos ou da loja (JWT do app) ou ?key= igual ao sync_secret da bling_config (cron). Por isso verify_jwt off.
// O Bling limita 3 requisições/s: pausa entre chamadas e nova tentativa quando recusa (429).
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const API = 'https://api.bling.com.br/Api/v3';
const pausa = (ms: number) => new Promise(r => setTimeout(r, ms));
const ehJwt = (t?: string) => !!t && t.split('.').length === 3;
const norm = (s: string) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const primeiroNome = (s: string) => norm(s).split(/\s+/)[0] || '';
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const LOJAS = ['Loja Areal', 'Loja Três Rios'];
const COL_SALDO: Record<string, string> = { 'Loja Areal': 'saldo_areal', 'Loja Três Rios': 'saldo_tres_rios', 'CD': 'saldo_cd' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const resposta = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj, null, 1), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function dataHoraSP(d: Date): string {
  // formato aceito nos filtros de data do Bling: "YYYY-MM-DD HH:MM:SS" (horário de Brasília)
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d);
  const g = (t: string) => p.find(x => x.type === t)?.value || '00';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}:${g('second')}`;
}
function somaDias(data: string, dias: number): string {
  const d = new Date(data + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// ---------------- Bling (token compartilhado com bling-sync) ----------------
type Res = { ok: boolean; status: number; json: any };
class Bling {
  private access = '';
  constructor(private sb: SupabaseClient, private cfg: any) {}

  // O refresh_token rotaciona: se dois processos renovarem juntos, o segundo falha.
  // Quem perder a corrida espera e relê o token que o outro gravou.
  async token(): Promise<string> {
    if (this.access) return this.access;
    for (let tentativa = 0; tentativa < 4; tentativa++) {
      const { data: tk } = await this.sb.from('bling_tokens').select('*').eq('id', 1).single();
      if (!tk?.refresh_token) throw new Error('Bling sem autorização — refaça o login do app no Bling');
      if (tk.access_token && tk.expires_at && new Date(tk.expires_at) > new Date(Date.now() + 120000)) {
        this.access = tk.access_token;
        return this.access;
      }
      const basic = btoa(`${this.cfg.client_id}:${this.cfg.client_secret}`);
      const r = await fetch(`${API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basic}`, 'Accept': '1.0', 'enable-jwt': '1' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tk.refresh_token }),
      });
      const nt = await r.json().catch(() => ({}));
      if (r.ok && nt.access_token) {
        await this.sb.from('bling_tokens').upsert({
          id: 1, access_token: nt.access_token, refresh_token: nt.refresh_token ?? tk.refresh_token,
          expires_at: new Date(Date.now() + ((nt.expires_in ?? 21600) - 300) * 1000).toISOString(), updated_at: new Date().toISOString(),
        });
        this.access = nt.access_token;
        return this.access;
      }
      await pausa(1500 * (tentativa + 1)); // outro processo pode ter renovado: relê
    }
    throw new Error('não consegui renovar o acesso ao Bling');
  }

  // GET repete em 429 e 5xx; escrita só repete em 429 (recusada = não processada), nunca em 5xx (poderia duplicar)
  async req(method: string, path: string, body?: unknown): Promise<Res> {
    const access = await this.token();
    const hdr: Record<string, string> = { 'Authorization': `Bearer ${access}`, 'Accept': 'application/json' };
    if (ehJwt(access)) hdr['enable-jwt'] = '1';
    if (body !== undefined) hdr['Content-Type'] = 'application/json';
    for (let tentativa = 0; ; tentativa++) {
      await pausa(tentativa === 0 ? 380 : 1000 * 2 ** tentativa);
      let r: Response;
      try {
        r = await fetch(API + path, { method, headers: hdr, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        if (method === 'GET' && tentativa < 3) continue;
        return { ok: false, status: 0, json: { erro: String(e) } };
      }
      const txt = await r.text();
      let json: any = {};
      try { json = txt ? JSON.parse(txt) : {}; } catch { json = { texto: txt.slice(0, 300) }; }
      const repete = r.status === 429 || (method === 'GET' && r.status >= 500);
      if (r.ok || tentativa >= 4 || !repete) return { ok: r.ok, status: r.status, json };
    }
  }
  get(path: string) { return this.req('GET', path); }
}

// mensagem legível de um erro do Bling
function erroBling(r: Res): string {
  const e = r.json?.error;
  if (e) {
    const campos = (e.fields || []).map((f: any) => f.msg || f.element).filter(Boolean).join('; ');
    return `${e.description || e.message || e.type || 'erro'}${campos ? ' — ' + campos : ''} (HTTP ${r.status})`;
  }
  return `HTTP ${r.status}${r.json?.erro ? ' ' + r.json.erro : ''}`;
}
const semPermissao = (r: Res) => r.status === 401 || r.status === 403;

// ---------------- configurar ----------------
async function configurar(sb: SupabaseClient, bl: Bling, cfgPdv: any, criarConsumidor: boolean) {
  const rel: Record<string, unknown> = {};
  const novo: Record<string, any> = {};

  // depósitos
  const rd = await bl.get('/depositos?limite=100');
  if (rd.ok) {
    const deps: Record<string, number> = { ...(cfgPdv.depositos || {}) };
    for (const d of rd.json.data || []) {
      const n = norm(d.descricao);
      if (/areal/.test(n)) deps['Loja Areal'] = d.id;
      else if (/tres rios/.test(n)) deps['Loja Três Rios'] = d.id;
      else if (/distribui/.test(n)) deps['CD'] = d.id;
    }
    novo.depositos = deps;
    rel.depositos = { ok: true, lista: (rd.json.data || []).map((d: any) => `${d.id} ${d.descricao}${d.padrao ? ' (padrão)' : ''}`), usados: deps };
  } else rel.depositos = { ok: false, erro: erroBling(rd), falta: semPermissao(rd) ? 'escopo Depósitos' : undefined };

  // formas de pagamento: confere as configuradas e acha o VALE TROCA
  const rf = await bl.get('/formas-pagamentos?limite=100');
  if (rf.ok) {
    const lista = rf.json.data || [];
    const formas = { ...(cfgPdv.formas || {}) };
    const vale = lista.find((f: any) => /vale/.test(norm(f.descricao)) && f.situacao !== 0);
    if (vale) formas.vale = vale.id;
    const porId = Object.fromEntries(lista.map((f: any) => [f.id, f]));
    const conferencia = Object.fromEntries(Object.entries(formas).map(([k, id]) => [k, id ? (porId[id as number] ? `${id} ${porId[id as number].descricao}` : `${id} NÃO EXISTE no Bling`) : 'NÃO CONFIGURADA']));
    novo.formas = formas;
    rel.formas = { ok: true, conferencia, todas: lista.filter((f: any) => f.situacao !== 0).map((f: any) => `${f.id} ${f.descricao}`) };
  } else rel.formas = { ok: false, erro: erroBling(rf), falta: semPermissao(rf) ? 'escopo Formas de Pagamento' : undefined };

  // contato Consumidor Final (usado quando a venda não tem cliente)
  const rc = await bl.get('/contatos?limite=20&pesquisa=' + encodeURIComponent('CONSUMIDOR FINAL'));
  if (rc.ok) {
    let c = (rc.json.data || []).find((x: any) => /consumidor final/.test(norm(x.nome)));
    if (!c && criarConsumidor) {
      const rn = await bl.req('POST', '/contatos', { nome: 'CONSUMIDOR FINAL', tipo: 'F', situacao: 'A' });
      if (rn.ok) c = { id: rn.json.data?.id, nome: 'CONSUMIDOR FINAL', criado: true };
      else rel.consumidorErro = erroBling(rn);
    }
    if (c?.id) novo.contato_consumidor_id = c.id;
    rel.consumidorFinal = c ? { ok: true, id: c.id, criado: !!c.criado } : { ok: false, erro: 'não existe — rode configurar com criar=true' };
  } else rel.consumidorFinal = { ok: false, erro: erroBling(rc), falta: semPermissao(rc) ? 'escopo Contatos' : undefined };

  // contas financeiras: o caixa de cada loja recebe a saída da devolução em dinheiro
  const rcc = await bl.get('/contas-contabeis?limite=100');
  if (rcc.ok) {
    const contas = { ...(cfgPdv.contas_caixa || {}) };
    for (const c of rcc.json.data || []) {
      const n = norm(c.descricao);
      if (!/caixa/.test(n)) continue;
      if (/areal/.test(n)) contas['Loja Areal'] = c.id;
      else if (/tres rios/.test(n)) contas['Loja Três Rios'] = c.id;
    }
    novo.contas_caixa = contas;
    rel.contasCaixa = { ok: true, usadas: contas, todas: (rcc.json.data || []).map((c: any) => `${c.id} ${c.descricao}`) };
  } else rel.contasCaixa = { ok: false, erro: erroBling(rcc), falta: semPermissao(rcc) ? 'escopo Caixas e Bancos / Contas financeiras' : undefined };

  // situações do módulo de vendas: códigos reais de "Atendido" e "Cancelado" nesta conta
  const rm = await bl.get('/situacoes/modulos');
  if (rm.ok) {
    const mod = (rm.json.data || []).find((m: any) => /venda/.test(norm(m.nome || m.descricao || '')) && !/compra|proposta|servico/.test(norm(m.nome || m.descricao || '')));
    const rsit = mod ? await bl.get(`/situacoes/modulos/${mod.id}`) : null;
    if (rsit?.ok) {
      const lista = rsit.json.data || [];
      const achar = (re: RegExp) => lista.find((s: any) => re.test(norm(s.nome || '')))?.id;
      const atendido = achar(/^atendido/), cancelado = achar(/^cancelado/);
      if (atendido) novo.situacao_atendido = atendido;
      if (cancelado) novo.situacao_cancelado = cancelado;
      rel.situacoes = { ok: true, modulo: mod.nome || mod.id, atendido, cancelado, todas: lista.map((s: any) => `${s.id} ${s.nome}`) };
    } else rel.situacoes = { ok: false, erro: rsit ? erroBling(rsit) : 'módulo de vendas não encontrado' };
  } else rel.situacoes = { ok: false, erro: erroBling(rm), falta: semPermissao(rm) ? 'escopo Situações' : undefined };

  // vendedoras: liga funcionarias ao vendedor do Bling e traz o limite de desconto
  rel.vendedoras = await sincronizarVendedoras(sb, bl);

  // testes de leitura/escrita que só dão para conferir pela permissão
  const rp = await bl.get('/produtos?limite=1&tipo=V');
  rel.produtos = rp.ok ? { ok: true } : { ok: false, erro: erroBling(rp), falta: semPermissao(rp) ? 'escopo Produtos' : undefined };
  const rs = await bl.get('/pedidos/vendas?limite=1');
  rel.pedidos = rs.ok ? { ok: true } : { ok: false, erro: erroBling(rs), falta: semPermissao(rs) ? 'escopo Pedidos de Venda' : undefined };
  if (novo.depositos && Object.values(novo.depositos)[0]) {
    const dep = Object.values(novo.depositos)[0] as number;
    const re = await bl.get(`/estoques/saldos/${dep}?idsProdutos[]=1`);
    rel.estoque = re.ok || re.status === 400 || re.status === 404 ? { ok: true } : { ok: false, erro: erroBling(re), falta: semPermissao(re) ? 'escopo Controle de Estoque' : undefined };
  }

  if (Object.keys(novo).length) await sb.from('pdv_config').update({ ...novo, atualizado_em: new Date().toISOString() }).eq('id', 1);
  return rel;
}

async function sincronizarVendedoras(sb: SupabaseClient, bl: Bling) {
  const rv = await bl.get('/vendedores?limite=100');
  if (!rv.ok) return { ok: false, erro: erroBling(rv), falta: semPermissao(rv) ? 'escopo Vendedores' : undefined };
  const { data: funcs } = await sb.from('funcionarias').select('id, nome, loja, ativa, bling_vendedor_id');
  const ligadas: string[] = [];
  for (const v of rv.json.data || []) {
    const rd = await bl.get(`/vendedores/${v.id}`);
    const det = rd.ok ? rd.json.data : v;
    const nome = det?.contato?.nome || v.contato?.nome || '';
    if (det?.contato?.situacao && det.contato.situacao !== 'A') continue;
    const f = (funcs || []).find(x => x.bling_vendedor_id === v.id) || (funcs || []).find(x => x.ativa && primeiroNome(x.nome) === primeiroNome(nome));
    if (!f) continue;
    await sb.from('funcionarias').update({ bling_vendedor_id: v.id, desconto_limite: det?.descontoLimite ?? null }).eq('id', f.id);
    ligadas.push(`${f.nome} (${f.loja}) ↔ ${nome}, desconto até ${det?.descontoLimite ?? '—'}%`);
  }
  const faltam = (funcs || []).filter(f => f.ativa && !ligadas.some(l => l.startsWith(f.nome + ' '))).map(f => `${f.nome} (${f.loja})`);
  return { ok: true, ligadas, semVendedorNoBling: faltam };
}

// ---------------- catálogo ----------------
async function sincronizarCatalogo(sb: SupabaseClient, bl: Bling, cfgPdv: any, completo: boolean) {
  const inicio = new Date();
  const desde = !completo && cfgPdv.catalogo_sync_em ? dataHoraSP(new Date(new Date(cfgPdv.catalogo_sync_em).getTime() - 10 * 60000)) : null;
  const vistos = new Set<number>();
  let gravados = 0;
  for (const tipo of ['PS', 'V']) {
    for (let pag = 1; pag < 200; pag++) {
      let path = `/produtos?tipo=${tipo}&criterio=${completo ? 2 : 5}&limite=100&pagina=${pag}`;
      if (desde) path += `&dataAlteracaoInicial=${encodeURIComponent(desde)}`;
      const r = await bl.get(path);
      if (!r.ok) throw new Error(`produtos (${tipo}) página ${pag}: ${erroBling(r)}`);
      const lote = r.json.data || [];
      const linhas = lote.filter((p: any) => p.formato !== 'V').map((p: any) => {
        vistos.add(p.id);
        return {
          bling_id: p.id, bling_pai_id: p.idProdutoPai || null, codigo: p.codigo || null, nome: p.nome || '(sem nome)',
          preco: Number(p.preco) || 0, formato: p.formato || null, situacao: p.situacao || 'A', atualizado_em: new Date().toISOString(),
        };
      });
      if (linhas.length) {
        const { error } = await sb.from('pdv_catalogo').upsert(linhas, { onConflict: 'bling_id' });
        if (error) throw new Error('gravar catálogo: ' + error.message);
        gravados += linhas.length;
      }
      if (lote.length < 100) break;
    }
  }
  // carga completa só lista ativos: o que não apareceu ficou inativo ou foi excluído no Bling
  let inativados = 0;
  if (completo && vistos.size) {
    const { data: ativos } = await sb.from('pdv_catalogo').select('bling_id').eq('situacao', 'A');
    const sumiram = (ativos || []).map(a => a.bling_id).filter(id => !vistos.has(id));
    for (let i = 0; i < sumiram.length; i += 500) {
      await sb.from('pdv_catalogo').update({ situacao: 'I' }).in('bling_id', sumiram.slice(i, i + 500));
    }
    inativados = sumiram.length;
  }
  await sb.from('pdv_config').update({ catalogo_sync_em: inicio.toISOString() }).eq('id', 1);
  return { gravados, inativados, desde };
}

async function sincronizarSaldos(sb: SupabaseClient, bl: Bling, cfgPdv: any) {
  const deps: Record<string, number> = cfgPdv.depositos || {};
  if (!Object.keys(deps).length) return { ok: false, erro: 'depósitos não configurados — rode configurar' };
  const ids: number[] = [];
  for (let de = 0; ; de += 1000) {
    const { data } = await sb.from('pdv_catalogo').select('bling_id').eq('situacao', 'A').range(de, de + 999);
    ids.push(...(data || []).map(d => d.bling_id));
    if (!data || data.length < 1000) break;
  }
  const saldos: Record<number, Record<string, number>> = {};
  for (const [local, dep] of Object.entries(deps)) {
    const col = COL_SALDO[local];
    if (!col || !dep) continue;
    for (let i = 0; i < ids.length; i += 100) {
      const q = ids.slice(i, i + 100).map(id => `idsProdutos[]=${id}`).join('&');
      const r = await bl.get(`/estoques/saldos/${dep}?${q}`);
      if (!r.ok) throw new Error(`saldos ${local}: ${erroBling(r)}`);
      for (const s of r.json.data || []) (saldos[s.produto?.id] ??= {})[col] = Number(s.saldoFisicoTotal) || 0;
    }
  }
  const linhas = Object.entries(saldos).map(([id, s]) => ({ bling_id: Number(id), ...s }));
  const { error } = await sb.rpc('pdv_aplicar_saldos', { p: linhas });
  if (error) throw new Error('gravar saldos: ' + error.message);
  return { ok: true, produtos: linhas.length };
}

async function buscarProduto(sb: SupabaseClient, bl: Bling, codigo: string) {
  const r = await bl.get(`/produtos?criterio=5&tipo=T&codigos[]=${encodeURIComponent(codigo)}`);
  if (!r.ok) throw new Error(erroBling(r));
  let lista = r.json.data || [];
  // código de um produto pai: traz as variações dele
  const pai = lista.find((p: any) => p.formato === 'V');
  if (pai) {
    const rv = await bl.get(`/produtos/variacoes/${pai.id}`);
    if (rv.ok) lista = (rv.json.data?.variacoes || []).map((v: any) => ({ ...v, idProdutoPai: pai.id, formato: 'S' }));
  }
  const linhas = lista.filter((p: any) => p.formato !== 'V').map((p: any) => ({
    bling_id: p.id, bling_pai_id: p.idProdutoPai || null, codigo: p.codigo || null, nome: p.nome || '(sem nome)',
    preco: Number(p.preco) || 0, formato: p.formato || 'S', situacao: p.situacao || 'A', atualizado_em: new Date().toISOString(),
  }));
  if (linhas.length) await sb.from('pdv_catalogo').upsert(linhas, { onConflict: 'bling_id' });
  return linhas;
}

// ---------------- envio de vendas ----------------
// vale-troca não é dinheiro novo: por padrão vira abatimento no pedido (desconto), assim o Bling não
// fica com conta a receber que nunca será paga nem conta o faturamento duas vezes. valeComoPagamento
// = jeito antigo (forma VALE-TROCA), usado só se o Bling recusar o pedido com o abatimento.
function montarParcelas(venda: any, formas: Record<string, number>, valeComoPagamento = false) {
  const parcelas: any[] = [];
  for (const pg of venda.pagamentos || []) {
    if (pg.forma === 'vale' && !valeComoPagamento) continue;
    const forma = formas[pg.forma];
    if (!forma) throw new Error(`forma de pagamento "${pg.forma}" não configurada no PDV`);
    const valor = r2(pg.valor);
    if (pg.forma === 'crediario' && Number(pg.parcelas) > 1) {
      const n = Number(pg.parcelas);
      const base = Math.floor((valor / n) * 100) / 100;
      for (let i = 0; i < n; i++) {
        const v = i === n - 1 ? r2(valor - base * (n - 1)) : base;
        parcelas.push({ dataVencimento: somaDias(venda.data, 30 * (i + 1)), valor: v, formaPagamento: { id: forma }, observacoes: `Crediário ${i + 1}/${n}` });
      }
    } else {
      const obs = pg.forma === 'credito_parcelado' ? `${pg.parcelas || 2}x no cartão` : pg.forma === 'vale' ? `Vale-troca ${pg.vale || ''}` : '';
      parcelas.push({ dataVencimento: pg.forma === 'crediario' ? somaDias(venda.data, 30) : venda.data, valor, formaPagamento: { id: forma }, ...(obs ? { observacoes: obs } : {}) });
    }
  }
  return parcelas;
}

// cliente com CPF vira contato no Bling (o crediário fica como conta a receber no nome dela)
async function contatoDaCliente(sb: SupabaseClient, bl: Bling, v: any): Promise<number | null> {
  const c = v.cliente;
  if (c?.bling_contato_id) return c.bling_contato_id;
  const cpf = String(c?.cpf || '').replace(/\D/g, '');
  if (!c?.nome || cpf.length !== 11) return null;
  const r = await bl.get(`/contatos?numeroDocumento=${cpf}&limite=5`);
  let id: number | undefined = r.ok ? r.json.data?.[0]?.id : undefined;
  if (!id) {
    const rn = await bl.req('POST', '/contatos', {
      nome: String(c.nome).toUpperCase(), numeroDocumento: cpf, tipo: 'F', situacao: 'A',
      ...(c.telefone ? { celular: String(c.telefone) } : {}),
    });
    if (!rn.ok) throw new Error('cadastrar cliente no Bling: ' + erroBling(rn));
    id = rn.json.data?.id;
  }
  if (!id) return null;
  v.cliente = { ...c, bling_contato_id: id };
  await sb.from('pdv_vendas').update({ cliente: v.cliente }).eq('id', v.id);
  return id;
}

const numeroLojaDe = (id: string) => 'PDV-' + id.replace(/-/g, '').slice(0, 12).toUpperCase();
const jaFeito = (r: Res) => /j[aá]\s+(foi\s+|est[aá]\s+|possui\s+|)?(lan[cç]ad|estornad)|already/i.test(JSON.stringify(r.json || {}));

async function enviarVenda(sb: SupabaseClient, bl: Bling, cfgPdv: any, cfgBling: any, id: string) {
  // pega a venda para si (evita o app e o cron mandarem a mesma venda ao mesmo tempo)
  const agora = new Date().toISOString();
  const { data: travada } = await sb.from('pdv_vendas')
    .update({ status: 'enviando', enviando_ate: new Date(Date.now() + 3 * 60000).toISOString() })
    .eq('id', id).or(`status.in.(pendente,erro),and(status.eq.enviando,enviando_ate.lt.${agora})`)
    .select('*').maybeSingle();
  if (!travada) return { id, pulada: true };
  const v = travada;
  const etapas: Record<string, any> = { ...(v.etapas || {}) };
  const salvar = (extra: Record<string, unknown> = {}) => sb.from('pdv_vendas').update({ etapas, ...extra }).eq('id', id);

  try {
    const lojaId = Object.entries(cfgBling.lojas_map || {}).find(([, nome]) => nome === v.loja)?.[0];
    const deposito = (cfgPdv.depositos || {})[v.loja];
    if (!lojaId) throw new Error(`loja "${v.loja}" sem ID do Bling em bling_config.lojas_map`);
    if (!deposito) throw new Error(`depósito da ${v.loja} não configurado — rode configurar`);

    // 1) pedido de venda (confere antes se já existe: reenviar nunca duplica)
    if (!v.bling_pedido_id) {
      const numeroLoja = numeroLojaDe(v.id);
      const rx = await bl.get(`/pedidos/vendas?numerosLojas[]=${numeroLoja}&limite=5`);
      let pedidoId: number | undefined = rx.ok ? rx.json.data?.[0]?.id : undefined;
      if (!pedidoId) {
        const temCrediario = (v.pagamentos || []).some((p: any) => p.forma === 'crediario');
        const daCliente = await contatoDaCliente(sb, bl, v);
        if (temCrediario && !daCliente) throw new Error('crediário sem cliente com CPF');
        const contato = daCliente || cfgPdv.contato_consumidor_id;
        if (!contato) throw new Error('contato Consumidor Final não configurado — rode configurar');
        const clienteObs = !daCliente && v.cliente?.nome ? ` — cliente ${v.cliente.nome}${v.cliente.telefone ? ' ' + v.cliente.telefone : ''}` : '';
        const { data: func } = v.funcionaria_id ? await sb.from('funcionarias').select('bling_vendedor_id').eq('id', v.funcionaria_id).maybeSingle() : { data: null };
        // peça avulsa (sem cadastro) vai sem produto: o Bling registra a venda e não mexe em estoque
        const itens = (v.itens || []).map((it: any) => ({
          ...(it.bling_id ? { produto: { id: it.bling_id } } : {}), codigo: it.codigo || (it.bling_id ? undefined : 'AVULSO'),
          descricao: it.nome, unidade: 'UN', quantidade: Number(it.qtd) || 1, valor: r2(it.preco),
        }));
        const vales = (v.pagamentos || []).filter((p: any) => p.forma === 'vale');
        const totalVale = r2(vales.reduce((s: number, p: any) => s + Number(p.valor), 0));
        const textoVale = vales.length ? ` — vale-troca ${vales.map((p: any) => `nº ${p.vale} ${r2(p.valor).toFixed(2)}`).join(', ')}` : '';
        const montar = (valeComoPagamento: boolean) => {
          const descontoBling = r2(Number(v.desconto || 0) + (valeComoPagamento ? 0 : totalVale));
          const p: Record<string, unknown> = {
            numeroLoja, data: v.data, dataSaida: v.data, dataPrevista: v.data,
            contato: { id: contato }, loja: { id: Number(lojaId) },
            itens, parcelas: montarParcelas(v, cfgPdv.formas || {}, valeComoPagamento),
            observacoes: `Venda PDV Shai ${numeroLoja.slice(4, 10)}${textoVale}`,
            observacoesInternas: `PDV Shai — ${v.vendedora || 'sem vendedora'} — venda ${v.id}${clienteObs}${textoVale}`,
          };
          if (descontoBling > 0) p.desconto = { valor: descontoBling, unidade: 'REAL' };
          if (func?.bling_vendedor_id) p.vendedor = { id: func.bling_vendedor_id };
          return p;
        };
        let rp = await bl.req('POST', '/pedidos/vendas', montar(false));
        etapas.vale = totalVale ? 'abatimento' : undefined;
        if (!rp.ok && totalVale > 0 && rp.status === 400) {
          // o Bling recusou o abatimento (ex.: pedido zerado ou limite de desconto): manda o vale como forma de pagamento
          rp = await bl.req('POST', '/pedidos/vendas', montar(true));
          etapas.vale = 'pagamento';
        }
        if (!rp.ok) throw new Error('criar pedido: ' + erroBling(rp));
        pedidoId = rp.json.data?.id;
        if (!pedidoId) throw new Error('o Bling não devolveu o ID do pedido');
      }
      v.bling_pedido_id = pedidoId;
      const rn = await bl.get(`/pedidos/vendas/${pedidoId}`);
      etapas.pedido = new Date().toISOString();
      await salvar({ bling_pedido_id: pedidoId, bling_numero: rn.ok ? rn.json.data?.numero ?? null : null });
    }
    const pid = v.bling_pedido_id;

    // 2) baixa o estoque no depósito da loja (não no CD, que é o padrão)
    if (!etapas.estoque) {
      const re = await bl.req('POST', `/pedidos/vendas/${pid}/lancar-estoque/${deposito}`);
      if (!re.ok && !jaFeito(re)) throw new Error('baixar estoque: ' + erroBling(re));
      etapas.estoque = new Date().toISOString();
      await salvar();
    }
    // 3) contas a receber (pagamentos)
    const semParcelas = montarParcelas(v, cfgPdv.formas || {}, etapas.vale === 'pagamento').length === 0;
    if (!etapas.contas && semParcelas) { etapas.contas = 'sem parcelas (pago todo com vale-troca)'; await salvar(); }
    if (!etapas.contas) {
      const rc = await bl.req('POST', `/pedidos/vendas/${pid}/lancar-contas`);
      if (!rc.ok && !jaFeito(rc)) throw new Error('lançar contas: ' + erroBling(rc));
      etapas.contas = new Date().toISOString();
      await salvar();
    }
    // 4) atendido
    if (!etapas.atendido) {
      const rs = await bl.req('PATCH', `/pedidos/vendas/${pid}/situacoes/${cfgPdv.situacao_atendido || 9}`);
      if (!rs.ok && !/mesma situa|j[aá] est[aá]/i.test(JSON.stringify(rs.json || {}))) throw new Error('marcar como atendido: ' + erroBling(rs));
      etapas.atendido = new Date().toISOString();
      await salvar();
    }
    // só fecha como enviada se ninguém pediu o cancelamento no meio do caminho
    await sb.from('pdv_vendas').update({ status: 'enviada', etapas, erro: null, enviando_ate: null, enviada_em: new Date().toISOString(), tentativas: (v.tentativas || 0) + 1 }).eq('id', id).eq('status', 'enviando');
    return { id, ok: true, pedido: pid };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from('pdv_vendas').update({ status: 'erro', etapas, erro: msg, enviando_ate: null, tentativas: (v.tentativas || 0) + 1 }).eq('id', id).eq('status', 'enviando');
    return { id, ok: false, erro: msg };
  }
}

// ---------------- cancelamento de venda (desfaz no Bling: estoque, contas e situação) ----------------
async function cancelarVenda(sb: SupabaseClient, bl: Bling, cfgPdv: any, id: string) {
  const agora = new Date().toISOString();
  const { data: v } = await sb.from('pdv_vendas')
    .update({ enviando_ate: new Date(Date.now() + 3 * 60000).toISOString() })
    .eq('id', id).eq('status', 'cancelar').or(`enviando_ate.is.null,enviando_ate.lt.${agora}`)
    .select('*').maybeSingle();
  if (!v) return { id, pulada: true };
  const canc: Record<string, any> = { ...(v.cancelamento || {}) };
  const et: Record<string, any> = { ...(canc.etapas || {}) };
  const salvar = () => sb.from('pdv_vendas').update({ cancelamento: { ...canc, etapas: et } }).eq('id', id);
  try {
    let pid = v.bling_pedido_id;
    if (!pid) {
      // pode ter sido criado sem a gente saber (resposta perdida): procura pelo numeroLoja
      const rx = await bl.get(`/pedidos/vendas?numerosLojas[]=${numeroLojaDe(v.id)}&limite=5`);
      if (!rx.ok) throw new Error('conferir pedido no Bling: ' + erroBling(rx));
      pid = rx.json.data?.[0]?.id || null;
    }
    if (pid) {
      if (!et.estoque) {
        const r = await bl.req('POST', `/pedidos/vendas/${pid}/estornar-estoque`);
        if (!r.ok && !jaFeito(r) && r.status !== 404) throw new Error('estornar estoque: ' + erroBling(r));
        et.estoque = new Date().toISOString(); await salvar();
      }
      if (!et.contas) {
        const r = await bl.req('POST', `/pedidos/vendas/${pid}/estornar-contas`);
        if (!r.ok && !jaFeito(r) && r.status !== 404) throw new Error('estornar contas: ' + erroBling(r));
        et.contas = new Date().toISOString(); await salvar();
      }
      if (!et.situacao) {
        const r = await bl.req('PATCH', `/pedidos/vendas/${pid}/situacoes/${cfgPdv.situacao_cancelado || 12}`);
        if (!r.ok && !/mesma situa|j[aá] est[aá]/i.test(JSON.stringify(r.json || {}))) throw new Error('marcar como cancelado: ' + erroBling(r));
        et.situacao = new Date().toISOString(); await salvar();
      }
    } else et.semPedido = 'a venda não tinha chegado ao Bling';
    await sb.from('pdv_vendas').update({ status: 'cancelada', cancelada_em: new Date().toISOString(), enviando_ate: null, bling_pedido_id: pid, cancelamento: { ...canc, etapas: et, erro: null } }).eq('id', id);
    return { id, ok: true, cancelada: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from('pdv_vendas').update({ enviando_ate: null, cancelamento: { ...canc, etapas: et, erro: msg, tentativas: (canc.tentativas || 0) + 1 } }).eq('id', id);
    return { id, ok: false, erro: msg };
  }
}

// ---------------- parcela de crediário recebida na loja: baixa a conta a receber no Bling ----------------
async function baixarParcela(sb: SupabaseClient, bl: Bling, cfgPdv: any, id: string) {
  const { data: p } = await sb.from('pdv_crediario').update({ bling_status: 'enviando' })
    .eq('id', id).not('pago_em', 'is', null).in('bling_status', ['pendente', 'erro']).select('*').maybeSingle();
  if (!p) return { id, pulada: true };
  try {
    const { data: v } = await sb.from('pdv_vendas').select('cliente, status, data, bling_pedido_id').eq('id', p.venda_id).maybeSingle();
    const contato = v?.cliente?.bling_contato_id;
    if (!contato || v?.status !== 'enviada') throw new Error('a venda ainda não foi lançada no Bling');
    const forma = (cfgPdv.formas || {}).crediario;
    const r = await bl.get(`/contas/receber?idContato=${contato}&situacoes[]=1&situacoes[]=3${forma ? `&idFormaPagamento=${forma}` : ''}&limite=100&dataInicial=${v.data}&tipoFiltroData=E`);
    if (!r.ok) throw new Error('procurar a parcela no Bling: ' + erroBling(r));
    const contas = r.json.data || [];
    const mesmoValor = (c: any) => Math.abs(Number(c.valor) - Number(p.valor)) < 0.01;
    const doPedido = (c: any) => !v.bling_pedido_id || c.origem?.id === v.bling_pedido_id;
    const conta = contas.find((c: any) => doPedido(c) && c.vencimento === p.vencimento && mesmoValor(c))
      || contas.find((c: any) => doPedido(c) && mesmoValor(c))
      || contas.find((c: any) => c.vencimento === p.vencimento && mesmoValor(c));
    if (!conta) throw new Error(`parcela ${p.numero}/${p.total_parcelas} (${p.valor}) não encontrada no Bling`);
    const rb = await bl.req('POST', `/contas/receber/${conta.id}/baixar`, {
      data: String(p.pago_em).slice(0, 10), valorRecebido: r2(p.pago_valor ?? p.valor),
      historico: `Crediário ${p.numero}/${p.total_parcelas} recebido na ${p.pago_loja || p.loja} (${p.pago_forma}) — PDV Shai`,
    });
    if (!rb.ok && !jaFeito(rb)) throw new Error('baixar parcela: ' + erroBling(rb));
    await sb.from('pdv_crediario').update({ bling_status: 'enviada', bling_erro: null }).eq('id', id);
    return { id, ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from('pdv_crediario').update({ bling_status: 'erro', bling_erro: msg, bling_tentativas: (p.bling_tentativas || 0) + 1 }).eq('id', id);
    return { id, ok: false, erro: msg };
  }
}

// ---------------- clientes já cadastradas no Bling ----------------
async function buscarClientes(bl: Bling, pesquisa: string) {
  const so = pesquisa.replace(/\D/g, '');
  const path = so.length === 11 ? `/contatos?numeroDocumento=${so}&limite=10` : `/contatos?pesquisa=${encodeURIComponent(pesquisa)}&limite=20`;
  const r = await bl.get(path);
  if (!r.ok) throw new Error(erroBling(r));
  return (r.json.data || []).filter((c: any) => !/consumidor final/.test(norm(c.nome)) && c.situacao !== 'E')
    .map((c: any) => ({ bling_contato_id: c.id, nome: c.nome, cpf: String(c.numeroDocumento || '').replace(/\D/g, '') || null, telefone: String(c.celular || c.telefone || '').replace(/\D/g, '') || null }));
}

// ---------------- envio de trocas (peças devolvidas voltam ao estoque da loja) ----------------
async function enviarTroca(sb: SupabaseClient, bl: Bling, cfgPdv: any, id: string) {
  const agora = new Date().toISOString();
  const { data: t } = await sb.from('pdv_trocas')
    .update({ status: 'enviando', enviando_ate: new Date(Date.now() + 3 * 60000).toISOString() })
    .eq('id', id).or(`status.in.(pendente,erro),and(status.eq.enviando,enviando_ate.lt.${agora})`)
    .select('*').maybeSingle();
  if (!t) return { id, pulada: true };
  const etapas: Record<string, any> = { ...(t.etapas || {}) };
  try {
    const deposito = (cfgPdv.depositos || {})[t.loja];
    if (!deposito) throw new Error(`depósito da ${t.loja} não configurado — rode configurar`);
    const itens = t.itens || [];
    for (let i = 0; i < itens.length; i++) {
      const it = itens[i];
      if (!it.volta_estoque || !it.bling_id || etapas[`item${i}`]) continue; // peça avulsa não tem estoque no Bling
      const r = await bl.req('POST', '/estoques', {
        produto: { id: it.bling_id }, deposito: { id: deposito }, operacao: 'E',
        quantidade: Number(it.qtd) || 1, preco: r2(it.preco),
        observacoes: `Devolução PDV Shai (${t.destino}) — troca ${String(t.id).slice(0, 8)}`,
      });
      if (!r.ok) throw new Error(`devolver ao estoque "${it.nome}": ` + erroBling(r));
      etapas[`item${i}`] = r.json.data?.id || true;
      await sb.from('pdv_trocas').update({ etapas }).eq('id', id);
    }
    // devolução em dinheiro do caixa: saída na conta financeira (caixa) da loja no Bling, se configurada
    const contaCaixa = (cfgPdv.contas_caixa || {})[t.loja];
    if (t.destino === 'dinheiro' && t.forma_reembolso === 'dinheiro' && contaCaixa && !etapas.caixa) {
      const rc = await bl.req('POST', '/caixas', {
        data: t.data, valor: r2(t.valor), debCred: 'D', contaFinanceira: { id: contaCaixa },
        observacoes: `Devolução em dinheiro PDV Shai — troca ${String(t.id).slice(0, 8)}${t.motivo ? ' — ' + t.motivo : ''}`,
      });
      if (!rc.ok) throw new Error('lançar saída no caixa do Bling: ' + erroBling(rc));
      etapas.caixa = rc.json.data?.id || true;
      await sb.from('pdv_trocas').update({ etapas }).eq('id', id);
    }
    await sb.from('pdv_trocas').update({ status: 'enviada', etapas, erro: null, enviando_ate: null, enviada_em: new Date().toISOString(), tentativas: (t.tentativas || 0) + 1 }).eq('id', id);
    return { id, ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from('pdv_trocas').update({ status: 'erro', etapas, erro: msg, enviando_ate: null, tentativas: (t.tentativas || 0) + 1 }).eq('id', id);
    return { id, ok: false, erro: msg };
  }
}

async function enviarFila(sb: SupabaseClient, bl: Bling, cfgPdv: any, cfgBling: any, filtroLoja: string | null) {
  const agora = new Date().toISOString();
  let qv = sb.from('pdv_vendas').select('id').or(`status.in.(pendente,erro),and(status.eq.enviando,enviando_ate.lt.${agora})`).lt('tentativas', 20).order('criado_em').limit(30);
  let qt = sb.from('pdv_trocas').select('id').or(`status.in.(pendente,erro),and(status.eq.enviando,enviando_ate.lt.${agora})`).lt('tentativas', 20).order('criado_em').limit(30);
  if (filtroLoja) { qv = qv.eq('loja', filtroLoja); qt = qt.eq('loja', filtroLoja); }
  let qc = sb.from('pdv_vendas').select('id').eq('status', 'cancelar').or(`enviando_ate.is.null,enviando_ate.lt.${agora}`).order('criado_em').limit(30);
  let qp = sb.from('pdv_crediario').select('id').not('pago_em', 'is', null).in('bling_status', ['pendente', 'erro']).lt('bling_tentativas', 20).limit(30);
  if (filtroLoja) { qc = qc.eq('loja', filtroLoja); qp = qp.eq('pago_loja', filtroLoja); }
  const [{ data: vs }, { data: ts }, { data: cs }, { data: ps }] = await Promise.all([qv, qt, qc, qp]);
  const out: unknown[] = [];
  for (const v of vs || []) out.push(await enviarVenda(sb, bl, cfgPdv, cfgBling, v.id));
  for (const c of cs || []) out.push(await cancelarVenda(sb, bl, cfgPdv, c.id));
  for (const t of ts || []) out.push(await enviarTroca(sb, bl, cfgPdv, t.id));
  for (const p of ps || []) out.push(await baixarParcela(sb, bl, cfgPdv, p.id));
  return out;
}

// ---------------- entrada ----------------
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: cfgBling } = await sb.from('bling_config').select('*').eq('id', 1).single();

  // quem está chamando
  let loja: string | null = null; // null = equipe/cron (todas as lojas)
  const key = url.searchParams.get('key');
  if (!(key && cfgBling?.sync_secret && key === cfgBling.sync_secret)) {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data } = jwt ? await sb.auth.getUser(jwt) : { data: { user: null } };
    const user = data?.user;
    if (!user?.email?.endsWith('@shai.local')) return resposta({ erro: 'não autorizado' }, 401);
    // papel e loja no app_metadata: só o servidor altera (o user_metadata a própria conta consegue mudar)
    const meta = user.app_metadata || {};
    if (meta.papel !== 'dono') {
      if (meta.papel !== 'loja' || !LOJAS.includes(meta.loja)) return resposta({ erro: 'login sem acesso ao caixa' }, 403);
      loja = meta.loja;
    }
  }

  let corpo: any = {};
  if (req.method === 'POST') corpo = await req.json().catch(() => ({}));
  const acao = corpo.acao || url.searchParams.get('acao') || '';
  const { data: cfgPdv } = await sb.from('pdv_config').select('*').eq('id', 1).single();
  const bl = new Bling(sb, cfgBling);

  try {
    if (acao === 'configurar') {
      if (loja) return resposta({ erro: 'só a equipe configura' }, 403);
      return resposta({ ok: true, ...(await configurar(sb, bl, cfgPdv, corpo.criar === true || url.searchParams.get('criar') === '1')) });
    }
    if (acao === 'catalogo') {
      if (loja) return resposta({ erro: 'só a equipe/cron' }, 403);
      const completo = corpo.completo === true || url.searchParams.get('completo') === '1';
      const cat = await sincronizarCatalogo(sb, bl, cfgPdv, completo);
      const vend = completo ? await sincronizarVendedoras(sb, bl) : undefined;
      const { data: cfg2 } = await sb.from('pdv_config').select('*').eq('id', 1).single();
      const saldos = url.searchParams.get('saldos') === '0' ? 'pulado' : await sincronizarSaldos(sb, bl, cfg2);
      return resposta({ ok: true, catalogo: cat, saldos, vendedoras: vend });
    }
    if (acao === 'buscar') {
      const codigo = String(corpo.codigo || url.searchParams.get('codigo') || '').trim();
      if (!codigo) return resposta({ erro: 'informe o código' }, 400);
      return resposta({ ok: true, produtos: await buscarProduto(sb, bl, codigo) });
    }
    if (acao === 'enviar') {
      if (corpo.venda) {
        const { data: v } = await sb.from('pdv_vendas').select('loja').eq('id', corpo.venda).maybeSingle();
        if (!v) return resposta({ erro: 'venda não encontrada' }, 404);
        if (loja && v.loja !== loja) return resposta({ erro: 'venda de outra loja' }, 403);
        return resposta(await enviarVenda(sb, bl, cfgPdv, cfgBling, corpo.venda));
      }
      if (corpo.troca) {
        const { data: t } = await sb.from('pdv_trocas').select('loja').eq('id', corpo.troca).maybeSingle();
        if (!t) return resposta({ erro: 'troca não encontrada' }, 404);
        if (loja && t.loja !== loja) return resposta({ erro: 'troca de outra loja' }, 403);
        return resposta(await enviarTroca(sb, bl, cfgPdv, corpo.troca));
      }
      if (corpo.parcela) {
        const { data: p } = await sb.from('pdv_crediario').select('pago_loja').eq('id', corpo.parcela).maybeSingle();
        if (!p) return resposta({ erro: 'parcela não encontrada' }, 404);
        if (loja && p.pago_loja !== loja) return resposta({ erro: 'parcela recebida em outra loja' }, 403);
        return resposta(await baixarParcela(sb, bl, cfgPdv, corpo.parcela));
      }
      return resposta({ ok: true, resultados: await enviarFila(sb, bl, cfgPdv, cfgBling, loja) });
    }
    if (acao === 'cancelar') {
      const { data: v } = await sb.from('pdv_vendas').select('loja').eq('id', corpo.venda).maybeSingle();
      if (!v) return resposta({ erro: 'venda não encontrada' }, 404);
      if (loja && v.loja !== loja) return resposta({ erro: 'venda de outra loja' }, 403);
      return resposta(await cancelarVenda(sb, bl, cfgPdv, corpo.venda));
    }
    if (acao === 'clientes') {
      const pesquisa = String(corpo.pesquisa || '').trim();
      if (pesquisa.length < 3) return resposta({ ok: true, clientes: [] });
      return resposta({ ok: true, clientes: await buscarClientes(bl, pesquisa) });
    }
    return resposta({ erro: 'ação desconhecida', acoes: ['configurar', 'catalogo', 'buscar', 'enviar', 'cancelar', 'clientes'] }, 400);
  } catch (e) {
    return resposta({ erro: e instanceof Error ? e.message : String(e) }, 500);
  }
});
