// ig-capa — recebe o link de um post/Reel público do Instagram (referência) e devolve a capa dele.
// Lê a imagem de prévia da página (a mesma que aparece quando o link é mandado no WhatsApp), guarda uma cópia
// no storage (o link da Meta expira em poucos dias) e devolve o endereço permanente.
// Chamada pelo app do calendário logado (verify_jwt ligado).
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // só quem está logado no app (a chave pública sozinha não basta)
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: quem } = await sb.auth.getUser(jwt);
  if (!quem?.user) return json({ erro: "entre no app para usar" }, 401);
  try {
    const { url } = await req.json();
    let u: URL;
    try { u = new URL(String(url)); } catch { return json({ erro: "link inválido" }, 400); }
    if (!/(^|\.)instagram\.com$|(^|\.)instagr\.am$/.test(u.hostname)) return json({ erro: "não é um link do Instagram" }, 400);
    // código do post (/reel/XXXX/ ou /p/XXXX/) vira o nome do arquivo: o mesmo link não baixa de novo
    const codigo = (u.pathname.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/) || [])[1];
    if (!codigo) return json({ erro: "não achei o post nesse link" }, 400);
    const caminho = `referencias/${codigo}.jpg`;
    const { data: pub } = sb.storage.from("produto-fotos").getPublicUrl(caminho);
    const ja = await fetch(pub.publicUrl, { method: "HEAD" });
    if (ja.ok) return json({ capa: pub.publicUrl, codigo });

    const pagina = await fetch(`https://www.instagram.com/${u.pathname.includes("/p/") ? "p" : "reel"}/${codigo}/`, {
      headers: { "User-Agent": "facebookexternalhit/1.1", "Accept-Language": "pt-BR" },
    });
    const html = await pagina.text();
    const m = html.match(/<meta property="og:image" content="([^"]+)"/);
    if (!m) return json({ erro: "o Instagram não mostrou a capa desse post (pode ser privado)" }, 404);
    const img = await fetch(m[1].replace(/&amp;/g, "&"));
    if (!img.ok) return json({ erro: "não consegui baixar a capa" }, 502);
    const { error } = await sb.storage.from("produto-fotos")
      .upload(caminho, await img.arrayBuffer(), { contentType: "image/jpeg", upsert: true });
    if (error) return json({ erro: error.message }, 500);
    return json({ capa: pub.publicUrl, codigo });
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
});
