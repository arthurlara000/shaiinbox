// ig-sync — busca os números do Instagram da loja (somente leitura) e grava no banco:
//   ig_conta_dia → alcance, visualizações, interações, seguidores ganhos/perdidos e total de seguidores por dia
//   ig_posts     → posts recentes com capa, legenda e números de cada um
// Roda todo dia de madrugada (pg_cron) e pode ser chamada na mão com ?key=<sync_secret>&dias=N.
// A chave do Instagram vem do Secret IG_TOKEN; a função renova a chave toda semana e guarda a renovada em ig_token.
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH = "https://graph.instagram.com/v23.0";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o, null, 2), { status, headers: { "Content-Type": "application/json" } });

// chamada à API do Instagram; a mensagem de erro da Meta não inclui a chave
async function ig(caminho: string, params: Record<string, string>, token: string) {
  const u = new URL(caminho.startsWith("http") ? caminho : GRAPH + caminho);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("access_token", token);
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return j;
}

async function sha(txt: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// dia no horário de Brasília (UTC-3, sem horário de verão)
const diaSP = (deslocamento = 0) => {
  const d = new Date(Date.now() - 3 * 3600e3);
  d.setUTCDate(d.getUTCDate() + deslocamento);
  return d.toISOString().slice(0, 10);
};
const inicioDia = (ds: string) => Math.floor(Date.parse(ds + "T00:00:00-03:00") / 1000);
const diaAnterior = (ds: string) => {
  const d = new Date(ds + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

// chave em uso: a renovada (ig_token) ou, se o Secret mudou, a nova do Secret. Renova uma vez por semana (vale 60 dias).
async function pegaToken(resumo: Record<string, unknown>) {
  const doSecret = Deno.env.get("IG_TOKEN")?.trim();
  if (!doSecret) throw new Error("Secret IG_TOKEN não encontrado");
  const hash = await sha(doSecret);
  const { data } = await sb.from("ig_token").select("token, renovado_em, env_hash").eq("id", 1).maybeSingle();
  let token = data && data.env_hash === hash ? data.token : doSecret;
  let renovadoEm = data && data.env_hash === hash ? Date.parse(data.renovado_em) : 0;
  if (!data || data.env_hash !== hash) {
    await sb.from("ig_token").upsert({ id: 1, token, env_hash: hash, renovado_em: new Date(0).toISOString() });
  }
  if (Date.now() - renovadoEm > 7 * 86400e3) {
    try {
      const j = await ig("https://graph.instagram.com/refresh_access_token", { grant_type: "ig_refresh_token" }, token);
      token = j.access_token;
      renovadoEm = Date.now();
      await sb.from("ig_token").upsert({ id: 1, token, env_hash: hash, renovado_em: new Date(renovadoEm).toISOString() });
      resumo.chave = `renovada (vale ~${Math.round((j.expires_in || 0) / 86400)} dias)`;
    } catch (e) {
      // chave com menos de 24h não pode ser renovada ainda: usa assim mesmo e tenta de novo amanhã
      resumo.chave = `sem renovar agora: ${(e as Error).message}`;
    }
  }
  return token;
}

// números da conta num dia fechado
async function insightsDoDia(uid: string, ds: string, token: string) {
  const since = String(inicioDia(ds)), until = String(inicioDia(ds) + 86400);
  const out: Record<string, number | string | null> = {};
  try {
    const j = await ig(`/${uid}/insights`, { metric: "reach,views,total_interactions", period: "day", metric_type: "total_value", since, until }, token);
    for (const m of j.data || []) out[m.name] = m.total_value?.value ?? null;
  } catch (e) { out.erro = (e as Error).message; }
  try {
    const j = await ig(`/${uid}/insights`, { metric: "follows_and_unfollows", period: "day", metric_type: "total_value", breakdown: "follow_type", since, until }, token);
    const res = j.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
    for (const r of res) {
      if (r.dimension_values?.[0] === "FOLLOWER") out.novos = r.value;
      if (r.dimension_values?.[0] === "NON_FOLLOWER") out.perdidos = r.value;
    }
    if (!res.length) { out.novos = 0; out.perdidos = 0; }
  } catch (e) { out.erro_seguidores = (e as Error).message; }
  return out;
}

// números de um post (Reels e posts aceitam conjuntos diferentes de métricas)
async function insightsDoPost(id: string, token: string) {
  for (const metric of ["reach,views,saved,shares,total_interactions", "reach,saved,shares,total_interactions", "reach,saved"]) {
    try {
      const j = await ig(`/${id}/insights`, { metric }, token);
      const o: Record<string, number> = {};
      for (const m of j.data || []) o[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
      return o;
    } catch { /* tenta o conjunto menor */ }
  }
  return {};
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const { data: cfg } = await sb.from("bling_config").select("sync_secret").eq("id", 1).maybeSingle();
  if (!cfg?.sync_secret || url.searchParams.get("key") !== cfg.sync_secret) return json({ erro: "não autorizado" }, 401);

  const resumo: Record<string, unknown> = {};
  try {
    const token = await pegaToken(resumo);
    const me = await ig("/me", { fields: "user_id,username,followers_count,media_count" }, token);
    const uid = String(me.user_id || me.id);
    resumo.conta = `@${me.username} · ${me.followers_count} seguidores · ${me.media_count} posts`;

    // primeira vez (ou pedido com ?dias=): busca os últimos 30 dias; no dia a dia, refaz os 3 últimos (os números assentam)
    const { count } = await sb.from("ig_conta_dia").select("dia", { count: "exact", head: true });
    const nDias = Math.min(30, Number(url.searchParams.get("dias")) || ((count || 0) < 20 ? 30 : 3));
    const ontem = diaSP(-1);
    const dias: string[] = [];
    for (let i = 0, d = ontem; i < nDias; i++, d = diaAnterior(d)) dias.push(d);

    const linhas: Record<string, Record<string, unknown>> = {};
    const erros: string[] = [];
    for (const ds of dias) {
      const r = await insightsDoDia(uid, ds, token);
      if (r.erro) erros.push(`${ds}: ${r.erro}`);
      if (r.erro_seguidores && !erros.some((x) => x.includes("seguidores"))) erros.push(`seguidores: ${r.erro_seguidores}`);
      linhas[ds] = { dia: ds, alcance: r.reach ?? null, visualizacoes: r.views ?? null, interacoes: r.total_interactions ?? null,
        novos: r.novos ?? null, perdidos: r.perdidos ?? null, atualizado_em: new Date().toISOString() };
    }

    // total de seguidores: o de agora vale para ontem; os dias anteriores são reconstruídos com ganhos − perdas
    const { data: existentes } = await sb.from("ig_conta_dia").select("dia, seguidores").in("dia", dias);
    const jaTem = new Map((existentes || []).map((e) => [e.dia, e.seguidores]));
    let seg: number | null = me.followers_count ?? null;
    for (const ds of dias) {
      const l = linhas[ds];
      l.seguidores = ds === ontem ? seg : (jaTem.get(ds) ?? seg);
      seg = (l.seguidores as number | null) ?? null; // um total já gravado de verdade vale mais que a conta
      const saldo = l.novos != null && l.perdidos != null ? Number(l.novos) - Number(l.perdidos) : null;
      seg = seg != null && saldo != null ? seg - saldo : null;
    }
    const { error: eConta } = await sb.from("ig_conta_dia").upsert(Object.values(linhas));
    if (eConta) erros.push("gravar conta: " + eConta.message);
    resumo.dias = `${dias.length} dias (${dias[dias.length - 1]} a ${ontem})`;

    // posts dos últimos 120 dias (até 60)
    const lista = await ig("/me/media", {
      fields: "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,like_count,comments_count",
      limit: "60",
    }, token);
    const limite = Date.now() - 120 * 86400e3;
    const posts = [];
    for (const m of lista.data || []) {
      if (Date.parse(m.timestamp) < limite) continue;
      const n = await insightsDoPost(m.id, token);
      posts.push({
        id: m.id, legenda: m.caption || null, tipo: m.media_type, formato: m.media_product_type,
        capa_url: m.thumbnail_url || m.media_url || null, link: m.permalink, publicado_em: m.timestamp,
        // arquivo do vídeo para tocar no app (a Meta omite em alguns vídeos com música protegida)
        video_url: m.media_type === "VIDEO" ? (m.media_url || null) : null,
        visualizacoes: n.views ?? null, alcance: n.reach ?? null, curtidas: m.like_count ?? null,
        comentarios: m.comments_count ?? null, salvos: n.saved ?? null, compartilhamentos: n.shares ?? null,
        atualizado_em: new Date().toISOString(),
      });
    }
    if (posts.length) {
      const { error: ePosts } = await sb.from("ig_posts").upsert(posts);
      if (ePosts) erros.push("gravar posts: " + ePosts.message);
    }
    resumo.posts = posts.length;
    if (erros.length) resumo.erros = erros.slice(0, 8);

    const ok = !erros.some((e) => e.startsWith("gravar"));
    await sb.from("ig_sync_log").insert({ ok, resumo });
    return json({ ok, ...resumo });
  } catch (e) {
    resumo.erro = (e as Error).message;
    await sb.from("ig_sync_log").insert({ ok: false, resumo });
    return json({ ok: false, ...resumo }, 500);
  }
});
