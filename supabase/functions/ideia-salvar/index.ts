// ideia-salvar — guarda no banco de ideias um post/Reel do Instagram mandado pelo botão Compartilhar.
//   Android: o app instalado recebe o compartilhamento e chama esta função logado (JWT da conta do calendário).
//   iPhone:  o Atalho "Mandar pro Shai" chama com ?key=<ideias_config.chave> (sem login).
// Corpo (JSON, form ou texto puro): { url | texto, autor?, origem? } — acha o primeiro link do Instagram no texto.
// Busca a capa pela prévia pública do post (a mesma do WhatsApp) e guarda uma cópia no storage.
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function lerCorpo(req: Request): Promise<Record<string, string>> {
  const tipo = req.headers.get("content-type") || "";
  const bruto = await req.text();
  if (tipo.includes("json")) { try { return JSON.parse(bruto); } catch { /* cai no texto */ } }
  if (tipo.includes("form")) return Object.fromEntries(new URLSearchParams(bruto));
  return { texto: bruto };
}

async function capaDoPost(tipo: string, codigo: string) {
  const caminho = `referencias/${codigo}.jpg`;
  const { data: pub } = sb.storage.from("produto-fotos").getPublicUrl(caminho);
  if ((await fetch(pub.publicUrl, { method: "HEAD" })).ok) return pub.publicUrl;
  // o Instagram às vezes nega a prévia para servidores: tenta como robô de prévia do Facebook, do WhatsApp e do X
  const tentativas: [string, string][] = [
    [`https://www.instagram.com/${tipo}/${codigo}/`, "facebookexternalhit/1.1"],
    [`https://www.instagram.com/p/${codigo}/`, "WhatsApp/2.23.20.0"],
    [`https://www.instagram.com/reel/${codigo}/`, "Twitterbot/1.0"],
  ];
  for (const [pagina, robo] of tentativas) {
    try {
      const html = await (await fetch(pagina, { headers: { "User-Agent": robo, "Accept-Language": "pt-BR" } })).text();
      const m = html.match(/<meta property="og:image" content="([^"]+)"/);
      if (!m) continue;
      const img = await fetch(m[1].replace(/&amp;/g, "&"));
      if (!img.ok) continue;
      const { error } = await sb.storage.from("produto-fotos")
        .upload(caminho, await img.arrayBuffer(), { contentType: "image/jpeg", upsert: true });
      if (!error) return pub.publicUrl;
    } catch { /* tenta a próxima */ }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  // quem pode: o app logado (JWT) ou o Atalho com a chave
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: quem } = jwt ? await sb.auth.getUser(jwt) : { data: null };
  let liberado = !!quem?.user;
  if (!liberado && url.searchParams.get("key")) {
    const { data: cfg } = await sb.from("ideias_config").select("chave").eq("id", 1).maybeSingle();
    liberado = !!cfg?.chave && url.searchParams.get("key") === cfg.chave;
  }
  if (!liberado) return json({ ok: false, mensagem: "Sem permissão" }, 401);

  try {
    const corpo = req.method === "GET" ? Object.fromEntries(url.searchParams) : await lerCorpo(req);
    const texto = [corpo.url, corpo.texto, corpo.text, corpo.title].filter(Boolean).join(" ");
    const achado = texto.match(/https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/[^\s"'<>]+/i);
    if (!achado) return json({ ok: false, mensagem: "Não achei um link do Instagram no que foi compartilhado" }, 400);
    const link = achado[0];
    const m = link.match(/\/(reels?|p|tv)\/([A-Za-z0-9_-]+)/);
    const codigo = m ? m[2] : null;
    const tipo = m && m[1] === "p" ? "p" : "reel";

    if (codigo) {
      const { data: ja } = await sb.from("ideias").select("id, status, capa").eq("codigo", codigo).maybeSingle();
      if (ja) {
        // já estava salva: volta para as novas se tinha sido arquivada, e tenta de novo a capa se faltou
        const muda: Record<string, unknown> = {};
        if (ja.status === "arquivada") muda.status = "nova";
        if (!ja.capa) { const c = await capaDoPost(tipo, codigo).catch(() => null); if (c) muda.capa = c; }
        if (Object.keys(muda).length) await sb.from("ideias").update(muda).eq("id", ja.id);
        return json({ ok: true, mensagem: "Essa ideia já estava salva no Shai", repetida: true });
      }
    }
    const capa = codigo ? await capaDoPost(tipo, codigo).catch(() => null) : null;
    const { error } = await sb.from("ideias").insert({
      link: codigo ? `https://www.instagram.com/${tipo}/${codigo}/` : link, codigo, capa,
      autor: (corpo.autor || url.searchParams.get("autor") || "").slice(0, 40) || null,
      origem: (corpo.origem || url.searchParams.get("origem") || "").slice(0, 20) || null,
      nota: (corpo.nota || "").slice(0, 500) || null,
    });
    if (error) return json({ ok: false, mensagem: error.message }, 500);
    return json({ ok: true, mensagem: "Salvo nas ideias do Shai ✓" });
  } catch (e) {
    return json({ ok: false, mensagem: (e as Error).message }, 500);
  }
});
