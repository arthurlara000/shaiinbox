// Etiqueta de envio pelo Melhor Envio, para o app Shai Site (quem cuida do site não abre painel nenhum).
// Ações (POST {acao}):
//   conectar  — GET ?acao=conectar: leva o navegador à autorização (state de uso único gravado no banco);
//               POST {acao:'conectar'} (donos): devolve o link para o app abrir.
//   autorizar — GET ?acao=autorizar&code=&state=: volta da autorização; troca o code pelo token (30 dias).
//   renovar   — GET ?acao=renovar: renova o token se faltar menos de 5 dias (cron semanal); toda chamada também renova sozinha.
//   status    — conectado? ambiente (sandbox/produção), saldo da carteira, remetente preenchido.
//   cotar     — {pedido_id, volume?}: serviços e preços para o pacote; sugere o que a cliente escolheu no site.
//   etiqueta  — {pedido_id, servico_id, volume?, nf_chave?}: carrinho → compra com o saldo → gera → link de impressão
//               → rastreio. Cada etapa fica gravada no pedido: se cair no meio, chamar de novo continua de onde parou.
//   imprimir  — {pedido_id}: link novo de impressão.   rastreio — {pedido_id}: atualiza o código.
//   cancelar  — {pedido_id}: cancela a etiqueta (o valor volta para a carteira, regra do Melhor Envio).
// Auth: login @shai.local com papel dono ou site. verify_jwt off (a volta da autorização vem sem login).
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const resposta = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const ESCOPOS = 'cart-read cart-write orders-read shipping-calculate shipping-cancel shipping-checkout shipping-companies shipping-generate shipping-preview shipping-print shipping-tracking transactions-read users-read';
const UFS: Record<string, string> = {
  'acre': 'AC', 'alagoas': 'AL', 'amapa': 'AP', 'amazonas': 'AM', 'bahia': 'BA', 'ceara': 'CE', 'distrito federal': 'DF',
  'espirito santo': 'ES', 'goias': 'GO', 'maranhao': 'MA', 'mato grosso': 'MT', 'mato grosso do sul': 'MS', 'minas gerais': 'MG',
  'para': 'PA', 'paraiba': 'PB', 'parana': 'PR', 'pernambuco': 'PE', 'piaui': 'PI', 'rio de janeiro': 'RJ',
  'rio grande do norte': 'RN', 'rio grande do sul': 'RS', 'rondonia': 'RO', 'roraima': 'RR', 'santa catarina': 'SC',
  'sao paulo': 'SP', 'sergipe': 'SE', 'tocantins': 'TO',
};
const norm = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const uf = (s: string | null | undefined) => { const t = String(s || '').trim(); return t.length === 2 ? t.toUpperCase() : (UFS[norm(t)] || t); };
const digitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');

const baseDe = (cfg: any) => cfg.ambiente === 'producao' ? 'https://melhorenvio.com.br' : 'https://sandbox.melhorenvio.com.br';
// a URL de retorno tem que ser idêntica à cadastrada no aplicativo do Melhor Envio
const redirectUri = () => `${Deno.env.get('SUPABASE_URL')}/functions/v1/melhorenvio?acao=autorizar`;
const userAgent = (cfg: any) => `Shai Sistema (${cfg.rem_email || 'loja.shai@outlook.com'})`;

// state de uso único guardado no banco (instâncias da função não compartilham memória)
async function novoState(sb: SupabaseClient) {
  const s = crypto.randomUUID();
  await sb.from('site_webhook_log').insert({ evento: 'melhorenvio/state', corpo: { state: s }, processado_em: null });
  return s;
}
async function stateOk(sb: SupabaseClient, s: string | null) {
  if (!s) return false;
  const desde = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data } = await sb.from('site_webhook_log').select('id').eq('evento', 'melhorenvio/state')
    .contains('corpo', { state: s }).is('processado_em', null).gte('recebido_em', desde).maybeSingle();
  if (!data) return false;
  await sb.from('site_webhook_log').update({ processado_em: new Date().toISOString() }).eq('id', data.id);
  return true;
}
async function linkAutorizar(sb: SupabaseClient, cfg: any) {
  const q = new URLSearchParams({ client_id: cfg.client_id, redirect_uri: redirectUri(), response_type: 'code', scope: ESCOPOS, state: await novoState(sb) });
  return `${baseDe(cfg)}/oauth/authorize?${q}`;
}

// ---------------- token ----------------
async function pedirToken(sb: SupabaseClient, cfg: any, corpo: Record<string, string>) {
  const r = await fetch(`${baseDe(cfg)}/oauth/token`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgent(cfg) },
    body: JSON.stringify({ client_id: cfg.client_id, client_secret: cfg.client_secret, ...corpo }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Melhor Envio recusou o token: ' + JSON.stringify(j).slice(0, 300));
  const novo = {
    access_token: j.access_token, refresh_token: j.refresh_token ?? cfg.refresh_token,
    expira_em: new Date(Date.now() + ((j.expires_in ?? 2592000) - 3600) * 1000).toISOString(),
  };
  await sb.from('melhorenvio_config').update(novo).eq('id', 1);
  Object.assign(cfg, novo);
}
async function token(sb: SupabaseClient, cfg: any) {
  if (!cfg.access_token) throw new Error('Melhor Envio não conectado');
  if (cfg.expira_em && new Date(cfg.expira_em) < new Date(Date.now() + 2 * 864e5) && cfg.refresh_token) {
    await pedirToken(sb, cfg, { grant_type: 'refresh_token', refresh_token: cfg.refresh_token });
  }
  return cfg.access_token;
}
async function me(sb: SupabaseClient, cfg: any, metodo: string, path: string, corpo?: unknown) {
  const r = await fetch(`${baseDe(cfg)}/api/v2/me${path}`, {
    method: metodo,
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${await token(sb, cfg)}`, 'User-Agent': userAgent(cfg) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const txt = await r.text();
  let j: any = null; try { j = txt ? JSON.parse(txt) : null; } catch { j = txt; }
  if (!r.ok) {
    let msg = typeof j === 'object' && j ? (j.message || j.error || '') : String(txt);
    if (j?.errors) msg += ' ' + Object.values(j.errors).flat().join(' ');
    throw new Error(`Melhor Envio: ${msg || r.status}`.slice(0, 400));
  }
  return j;
}

// ---------------- pacote ----------------
async function montarPacote(sb: SupabaseClient, cfg: any, ped: any, volume?: any) {
  const itens = (ped.itens || []) as any[];
  const varIds = itens.map(i => i.variacao_id).filter(Boolean);
  const { data: vs } = varIds.length ? await sb.from('produto_variacoes').select('id, produtos(peso_g)').in('id', varIds) : { data: [] };
  const { data: nc } = await sb.from('nuvemshop_config').select('peso_padrao_g').eq('id', 1).maybeSingle();
  const pesoPeca = (id: string) => ((vs || []) as any[]).find((v: any) => v.id === id)?.produtos?.peso_g || nc?.peso_padrao_g || 400;
  const gramas = itens.reduce((s, i) => s + pesoPeca(i.variacao_id) * Number(i.qtd || 1), 0) + (cfg.emb_peso_g || 0);
  const v = {
    height: Math.max(1, Math.round(Number(volume?.altura ?? cfg.emb_altura))),
    width: Math.max(1, Math.round(Number(volume?.largura ?? cfg.emb_largura))),
    length: Math.max(1, Math.round(Number(volume?.comprimento ?? cfg.emb_comprimento))),
    weight: Math.round(Number(volume?.peso_g ?? gramas)) / 1000,
  };
  return v;
}
const valorSeguro = (ped: any) => Math.max(0, Number(ped.subtotal || 0) - Number(ped.desconto || 0));

function remetente(cfg: any) {
  const falta = ['rem_nome', 'rem_cnpj', 'rem_cep', 'rem_endereco', 'rem_numero', 'rem_bairro', 'rem_cidade', 'rem_uf'].filter(k => !cfg[k]);
  if (falta.length) throw new Error('Falta preencher o remetente (dados do CD) na configuração do Melhor Envio');
  return {
    name: cfg.rem_nome, company_document: digitos(cfg.rem_cnpj), phone: digitos(cfg.rem_telefone) || undefined, email: cfg.rem_email || undefined,
    address: cfg.rem_endereco, number: cfg.rem_numero, complement: cfg.rem_complemento || undefined, district: cfg.rem_bairro,
    city: cfg.rem_cidade, state_abbr: uf(cfg.rem_uf), country_id: 'BR', postal_code: digitos(cfg.rem_cep),
  };
}
function destinatario(ped: any) {
  const e = ped.endereco || {};
  const cep = digitos(e.zipcode);
  if (cep.length !== 8) throw new Error('Pedido sem CEP de entrega válido');
  return {
    name: e.name || ped.cliente_nome, document: digitos(ped.cliente_cpf) || undefined,
    phone: digitos(e.phone || ped.cliente_whatsapp) || undefined, email: ped.cliente_email || undefined,
    address: e.address, number: e.number || 's/n', complement: e.floor || undefined, district: e.locality || 'Centro',
    city: e.city || ped.cliente_cidade, state_abbr: uf(e.province || ped.cliente_uf), country_id: 'BR', postal_code: cep,
  };
}

// o serviço que a cliente escolheu no site (ex.: "SEDEX", "Jadlog .Package") vira a sugestão
function sugerir(servicos: any[], envio: unknown) {
  const alvo = norm(typeof envio === 'string' ? envio : ((envio as any)?.name || ''));
  if (!alvo) return null;
  const achado = servicos.find(s => alvo.includes(norm(s.servico))) || servicos.find(s => norm(s.nome).split(' ').every(p => alvo.includes(p)));
  return achado?.id ?? null;
}

async function cotar(sb: SupabaseClient, cfg: any, ped: any, volume?: any) {
  const pacote = await montarPacote(sb, cfg, ped, volume);
  const r = await me(sb, cfg, 'POST', '/shipment/calculate', {
    from: { postal_code: digitos(cfg.rem_cep) }, to: { postal_code: digitos(ped.endereco?.zipcode) },
    package: pacote, options: { insurance_value: valorSeguro(ped), receipt: false, own_hand: false },
    ...(cfg.servicos ? { services: cfg.servicos } : {}), // só o que a Shai consegue postar
  });
  const servicos = (Array.isArray(r) ? r : []).filter((s: any) => !s.error).map((s: any) => ({
    id: s.id, servico: s.name, empresa: s.company?.name || '', nome: `${s.company?.name || ''} ${s.name}`.trim(),
    preco: Number(s.custom_price ?? s.price), prazo: s.custom_delivery_time ?? s.delivery_time,
  })).sort((a: any, b: any) => a.preco - b.preco);
  return { servicos, sugerido: sugerir(servicos, ped.envio_metodo), pacote, frete_cobrado: Number(ped.frete || 0) };
}

// ---------------- etiqueta (retomável) ----------------
async function gerarEtiqueta(sb: SupabaseClient, cfg: any, ped: any, corpo: any) {
  const salvar = async (campos: any) => {
    const { data } = await sb.from('site_pedidos').update({ ...campos, atualizado_em: new Date().toISOString() }).eq('id', ped.id).select().single();
    Object.assign(ped, data || campos);
  };
  if (corpo.nf_chave !== undefined) {
    const k = digitos(corpo.nf_chave);
    if (k && k.length !== 44) throw new Error('A chave da nota tem 44 números');
    if (k) await salvar({ nf_chave: k });
  }
  let id = ped.etiqueta_status && ped.etiqueta_status !== 'cancelada' ? ped.etiqueta_me_id : null;

  if (!id) {
    if (!corpo.servico_id) throw new Error('Escolha o serviço de envio');
    const pacote = await montarPacote(sb, cfg, ped, corpo.volume);
    const comNota = !!ped.nf_chave;
    if (!comNota && !corpo.sem_nota) throw new Error('Informe a chave da nota fiscal (ou confirme o envio com declaração de conteúdo)');
    const from: any = remetente(cfg);
    from.state_register = comNota ? (cfg.rem_ie || undefined) : 'ISENTO';
    const jadlog = [3, 4, 27].includes(Number(corpo.servico_id));
    const carrinho = await me(sb, cfg, 'POST', '/cart', {
      service: Number(corpo.servico_id),
      ...(jadlog && cfg.agencia_jadlog ? { agency: Number(cfg.agencia_jadlog) } : {}), // ponto de postagem em Três Rios
      from, to: destinatario(ped),
      products: (ped.itens || []).map((i: any) => ({
        name: [i.descricao, i.cor, i.tamanho].filter(Boolean).join(' '), quantity: String(i.qtd || 1), unitary_value: Number(i.valor || 0).toFixed(2),
      })),
      volumes: [pacote],
      options: {
        insurance_value: valorSeguro(ped), receipt: false, own_hand: false, reverse: false,
        non_commercial: !comNota, ...(comNota ? { invoice: { key: ped.nf_chave } } : {}),
        platform: 'Shai', tags: [{ tag: `Pedido ${ped.numero}` }],
      },
    });
    id = carrinho.id;
    await salvar({ etiqueta_me_id: id, etiqueta_status: 'carrinho', etiqueta_preco: Number(carrinho.price ?? 0) || null, etiqueta_servico: corpo.servico_nome || null, etiqueta_url: null });
  }
  if (ped.etiqueta_status === 'carrinho') {
    await me(sb, cfg, 'POST', '/shipment/checkout', { orders: [id] }); // paga com o saldo da carteira
    await salvar({ etiqueta_status: 'paga' });
  }
  if (ped.etiqueta_status === 'paga') {
    await me(sb, cfg, 'POST', '/shipment/generate', { orders: [id] });
    await salvar({ etiqueta_status: 'gerada', etiqueta_em: new Date().toISOString() });
  }
  await imprimir(sb, cfg, ped, salvar);
  await rastrear(sb, cfg, ped, salvar).catch(() => {}); // o código pode demorar alguns segundos para sair
  return ped;
}
// etiqueta como arquivo PDF 10x15 (o mesmo padrão de todas as etiquetas da Shai, para a impressora térmica);
// se o arquivo não vier, cai no link de impressão do Melhor Envio
async function imprimir(sb: SupabaseClient, cfg: any, ped: any, salvar: (c: any) => Promise<void>) {
  if (ped.etiqueta_status !== 'gerada') throw new Error('Etiqueta ainda não gerada');
  let url: string | null = null;
  try {
    const arq = await me(sb, cfg, 'GET', `/imprimir/pdf/${ped.etiqueta_me_id}`);
    url = typeof arq === 'string' ? arq : (arq?.url || arq?.link || null);
  } catch { /* segue para o link de impressão */ }
  if (!url) url = (await me(sb, cfg, 'POST', '/shipment/print', { mode: 'public', orders: [ped.etiqueta_me_id] }))?.url;
  await salvar({ etiqueta_url: url });
}
async function rastrear(sb: SupabaseClient, cfg: any, ped: any, salvar: (c: any) => Promise<void>) {
  const t = await me(sb, cfg, 'POST', '/shipment/tracking', { orders: [ped.etiqueta_me_id] });
  const info = t?.[ped.etiqueta_me_id];
  const codigo = info?.tracking || info?.melhorenvio_tracking;
  if (codigo && codigo !== ped.rastreio) await salvar({ rastreio: codigo });
  return info;
}

// o Supabase não mostra HTML formatado no endereço padrão das funções: resposta em texto simples
const pagina = (titulo: string, texto: string) =>
  new Response(`${titulo}. ${texto}`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

// ---------------- entrada ----------------
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: cfg } = await sb.from('melhorenvio_config').select('*').eq('id', 1).single();

  const acaoUrl = url.searchParams.get('acao') || '';
  if (req.method === 'GET' && acaoUrl === 'conectar') {
    if (!cfg?.client_id || !cfg?.client_secret) return pagina('Falta configurar', 'Cadastre o client id e o secret do aplicativo do Melhor Envio.');
    return Response.redirect(await linkAutorizar(sb, cfg), 302);
  }
  if (req.method === 'GET' && acaoUrl === 'renovar') {
    try {
      if (!cfg?.refresh_token) return resposta({ ok: false, erro: 'sem refresh_token' }, 400);
      const falta = cfg.expira_em ? new Date(cfg.expira_em).getTime() - Date.now() : 0;
      if (falta > 5 * 864e5 && url.searchParams.get('forcar') !== '1') return resposta({ ok: true, renovado: false });
      await pedirToken(sb, cfg, { grant_type: 'refresh_token', refresh_token: cfg.refresh_token });
      return resposta({ ok: true, renovado: true });
    } catch (e: any) { return resposta({ ok: false, erro: String(e.message || e) }, 500); }
  }
  // volta da autorização: o code só vale junto com o nosso client_secret, e o state só uma vez
  if (req.method === 'GET' && url.searchParams.get('code')) {
    if (!cfg?.client_id || !cfg?.client_secret) return pagina('Falta configurar', 'Cadastre o client id e o secret do aplicativo do Melhor Envio.');
    if (!(await stateOk(sb, url.searchParams.get('state')))) return pagina('Link expirado', 'Abra de novo o link de conectar o Melhor Envio.');
    try {
      await pedirToken(sb, cfg, { grant_type: 'authorization_code', redirect_uri: redirectUri(), code: url.searchParams.get('code')! });
      await sb.from('melhorenvio_config').update({ conectado_em: new Date().toISOString() }).eq('id', 1);
      return pagina('Melhor Envio conectado', `Pronto (${cfg.ambiente === 'producao' ? 'produção' : 'ambiente de teste'}). As etiquetas já podem ser geradas pelo Shai Site.`);
    } catch (e: any) { return pagina('Não deu certo', String(e.message || e)); }
  }

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data } = jwt ? await sb.auth.getUser(jwt) : { data: { user: null } };
  const user = data?.user;
  if (!user?.email?.endsWith('@shai.local')) return resposta({ erro: 'não autorizado' }, 401);
  const papel = user.app_metadata?.papel || '';
  if (!['dono', 'site'].includes(papel)) return resposta({ erro: 'login sem acesso ao site' }, 403);

  const corpo: any = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const acao = corpo.acao || url.searchParams.get('acao') || '';
  try {
    if (acao === 'status') {
      const conectado = !!cfg?.access_token;
      let saldo: number | null = null;
      if (conectado) { try { const b = await me(sb, cfg, 'GET', '/balance'); saldo = Number(b?.balance ?? null); } catch { /* sem escopo/saldo: segue */ } }
      const remetenteOk = !!(cfg?.rem_nome && cfg?.rem_cnpj && cfg?.rem_cep && cfg?.rem_endereco);
      return resposta({ conectado, ambiente: cfg?.ambiente, saldo, remetente_ok: remetenteOk, configurado: !!cfg?.client_id });
    }
    if (acao === 'conectar') {
      if (papel !== 'dono') return resposta({ erro: 'só os donos' }, 403);
      if (!cfg?.client_id) return resposta({ erro: 'Cadastre primeiro o client id e o secret do aplicativo' }, 409);
      return resposta({ link: await linkAutorizar(sb, cfg) });
    }

    const { data: ped } = await sb.from('site_pedidos').select('*').eq('id', corpo.pedido_id).single();
    if (!ped) return resposta({ erro: 'pedido não encontrado' }, 404);
    if (['aberto', 'cancelado'].includes(ped.status)) return resposta({ erro: 'Pedido não está pago' }, 409);
    const salvar = async (campos: any) => {
      const { data: d } = await sb.from('site_pedidos').update({ ...campos, atualizado_em: new Date().toISOString() }).eq('id', ped.id).select().single();
      Object.assign(ped, d || campos);
    };

    if (acao === 'cotar') return resposta(await cotar(sb, cfg, ped, corpo.volume));
    if (acao === 'etiqueta') return resposta({ ok: true, pedido: await gerarEtiqueta(sb, cfg, ped, corpo) });
    if (acao === 'imprimir') { await imprimir(sb, cfg, ped, salvar); return resposta({ ok: true, url: ped.etiqueta_url }); }
    if (acao === 'rastreio') { const info = await rastrear(sb, cfg, ped, salvar); return resposta({ ok: true, rastreio: ped.rastreio, status: info?.status }); }
    if (acao === 'cancelar') {
      if (!ped.etiqueta_me_id || ped.etiqueta_status === 'cancelada') return resposta({ erro: 'sem etiqueta para cancelar' }, 409);
      if (ped.etiqueta_status !== 'carrinho') {
        await me(sb, cfg, 'POST', '/shipment/cancel', { order: { id: ped.etiqueta_me_id, reason_id: '2', description: corpo.motivo || 'Cancelada pela loja' } });
      } else {
        await me(sb, cfg, 'DELETE', `/cart/${ped.etiqueta_me_id}`);
      }
      await salvar({ etiqueta_status: 'cancelada', etiqueta_url: null, rastreio: ped.status === 'enviado' ? ped.rastreio : null });
      return resposta({ ok: true });
    }
    return resposta({ erro: 'ação desconhecida' }, 400);
  } catch (e: any) {
    return resposta({ erro: String(e?.message || e) }, 500);
  }
});
