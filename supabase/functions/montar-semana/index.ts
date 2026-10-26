// montar-semana — a IA monta os posts dos dias vazios da grade do Planejar.
// Lê o que deu certo no Instagram da Shai (ig_posts), as ideias salvas pela equipe e a agenda (campanhas,
// eventos e datas que o app manda) e devolve, para cada dia: formato, gancho, cenas, legenda, peça e o porquê.
// Só para quem está logado no calendário. A chave da IA fica no secret ANTHROPIC_API_KEY.
// Corpo: { dias: ['2026-10-27', …], pedido?, datas?: [{data, titulo, desc}], planejados?: [{data, texto}], evitar?: [texto] }
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const DIAS_SEM = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
// horário de Brasília (sem horário de verão desde 2019)
const brt = (t: string) => new Date(new Date(t).getTime() - 3 * 3600 * 1000);
const corta = (s: string | null, n: number) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);

const SISTEMA = `Você é a estrategista de conteúdo do Instagram da Loja Shai (@loja.shai): moda feminina, duas lojas físicas
no interior do Rio de Janeiro (Areal e Três Rios) e vendas pelo WhatsApp. Quem grava é a própria equipe da loja, com o
celular, dentro da loja ou perto dela — então tudo precisa ser simples de gravar em poucos minutos.

Seu trabalho: montar um post para cada dia pedido, olhando para os números reais da conta e para o que a equipe já planejou.

Como decidir:
- Aprenda com os posts da Shai: compare alcance, visualizações, compartilhamentos e salvos por formato, tema, dia e
  horário. Repita o que funciona e varie o tema para não cansar. Use a média da conta como referência.
- Se houver ideias salvas pela equipe (vídeos de outros perfis), use as que combinam com a semana e informe o id em
  ideia_id. Ideia marcada como tendência tem prioridade. Não use a mesma ideia em dois dias.
- Respeite a agenda: campanhas, eventos e datas comemorativas próximas devem aparecer nos dias certos (inclusive o
  aquecimento antes delas). Se a pessoa fez um pedido de foco, ele manda.
- Não repita o que já está planejado nem o que for pedido para evitar.
- Peça: use peças citadas nas legendas recentes (os lançamentos). Se não souber o nome, descreva o tipo de peça
  (ex.: "blusa de renda dos lançamentos"). Nunca invente preço.

Formato de cada post:
- titulo: até 6 palavras, para reconhecer o post na grade.
- gancho: a frase falada ou escrita nos 3 primeiros segundos (para Reel) ou a capa (carrossel/foto).
- cenas: de 3 a 6 tomadas curtas, na ordem, cada uma com o que filmar (para carrossel/foto: o que fotografar em cada imagem).
- legenda: pronta para postar, no tom da Shai (próximo, carinhoso, "vocês", emojis 🤎✨ com moderação), terminando com
  um convite para chamar no WhatsApp ou ir à loja; no máximo 3 hashtags.
- porque: uma frase citando o número que justifica a escolha (ex.: "Reels de arrume-se comigo tiveram 1,6× o alcance médio").
- leitura (uma só, para a semana toda): duas frases sobre o que está funcionando na conta agora.
Escreva tudo em português do Brasil.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["leitura", "posts"],
  properties: {
    leitura: { type: "string" },
    posts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["data", "formato", "titulo", "gancho", "cenas", "legenda", "peca", "ideia_id", "porque"],
        properties: {
          data: { type: "string", description: "AAAA-MM-DD, um dos dias pedidos" },
          formato: { type: "string", enum: ["reel", "carrossel", "foto"] },
          titulo: { type: "string" },
          gancho: { type: "string" },
          cenas: { type: "array", items: { type: "string" } },
          legenda: { type: "string" },
          peca: { type: "string" },
          ideia_id: { type: "string", description: "id da ideia salva usada, ou vazio" },
          porque: { type: "string" },
        },
      },
    },
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: quem } = jwt ? await sb.auth.getUser(jwt) : { data: null };
  if (!quem?.user) return json({ ok: false, mensagem: "Entre no app para usar" }, 401);
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return json({ ok: false, mensagem: "Falta a chave da IA no Supabase (secret ANTHROPIC_API_KEY)" }, 500);
  }

  try {
    const corpo = await req.json();
    const dias: string[] = (corpo.dias || []).filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 12);
    if (!dias.length) return json({ ok: false, mensagem: "Nenhum dia vazio para montar" }, 400);

    const desde = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const ate = dias[dias.length - 1];
    const [posts, ideias, campanhas] = await Promise.all([
      sb.from("ig_posts").select("tipo, formato, legenda, publicado_em, visualizacoes, alcance, curtidas, comentarios, salvos, compartilhamentos")
        .gte("publicado_em", desde).order("publicado_em", { ascending: false }).limit(90),
      sb.from("ideias").select("id, link, autor, nota, objetivo, peca, peca_detalhe, prazo, atencao").eq("status", "nova").limit(40),
      sb.from("campanhas").select("titulo, data_campanha, ideia, objetivo, meta, oferta, status")
        .gte("data_campanha", hoje).lte("data_campanha", ate.slice(0, 8) + "31").order("data_campanha"),
    ]);

    // posts da Shai: uma linha por post + média de alcance por formato
    const lp = (posts.data || []).map((p) => {
      const t = brt(p.publicado_em);
      const fmt = p.formato === "REELS" ? "reel" : p.tipo === "CAROUSEL_ALBUM" ? "carrossel" : "foto";
      return `${t.toISOString().slice(0, 10)} ${DIAS_SEM[t.getUTCDay()]} ${t.getUTCHours()}h | ${fmt} | alcance ${p.alcance ?? "?"} | ` +
        `views ${p.visualizacoes ?? "?"} | curt ${p.curtidas ?? 0} | coment ${p.comentarios ?? 0} | salvos ${p.salvos ?? 0} | ` +
        `compart ${p.compartilhamentos ?? 0} | "${corta(p.legenda, 160)}"`;
    });
    const medias: Record<string, number[]> = {};
    (posts.data || []).forEach((p) => {
      const fmt = p.formato === "REELS" ? "reel" : p.tipo === "CAROUSEL_ALBUM" ? "carrossel" : "foto";
      (medias[fmt] = medias[fmt] || []).push(p.alcance || 0);
    });
    const lm = Object.entries(medias).map(([f, v]) =>
      `${f}: ${v.length} posts, alcance médio ${Math.round(v.reduce((s, x) => s + x, 0) / v.length)}`);

    const li = (ideias.data || []).map((x) =>
      `id ${x.id} | de ${x.autor || "?"} | ${x.link}` +
      (x.prazo === "tendencia" ? " | TENDÊNCIA" : "") +
      (x.objetivo ? ` | objetivo: ${x.objetivo}` : "") +
      (x.atencao?.length ? ` | copiar: ${x.atencao.join(", ")}` : "") +
      (x.peca_detalhe || (x.peca && x.peca !== "nao_sei") ? ` | peça: ${x.peca_detalhe || x.peca}` : "") +
      (x.nota ? ` | nota: ${corta(x.nota, 200)}` : ""));

    const la = [
      ...(campanhas.data || []).map((c) =>
        `${c.data_campanha} CAMPANHA "${c.titulo}" (${c.status})` +
        (c.ideia ? ` — ${corta(c.ideia, 300)}` : "") + (c.objetivo ? ` | objetivo: ${c.objetivo}` : "") +
        (c.oferta ? ` | oferta: ${corta(c.oferta, 150)}` : "")),
      ...(corpo.datas || []).slice(0, 15).map((d: { data: string; titulo: string; desc?: string }) =>
        `${d.data} ${corta(d.titulo, 60)}${d.desc ? " — " + corta(d.desc, 120) : ""}`),
    ];
    const lj = (corpo.planejados || []).slice(0, 30).map((p: { data: string; texto: string }) => `${p.data}: ${corta(p.texto, 160)}`);
    const le = (corpo.evitar || []).slice(0, 10).map((t: string) => corta(t, 160));

    const rot = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return `${d} (${DIAS_SEM[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]})`; };
    const pedido = [
      `Hoje é ${rot(hoje)}. Monte um post para cada um destes dias: ${dias.map(rot).join(", ")}.`,
      corpo.pedido ? `Pedido de foco da equipe: ${corta(corpo.pedido, 400)}` : "",
      `\n## Posts da Shai nos últimos 60 dias (mais novo primeiro)\n${lp.join("\n") || "(nenhum)"}`,
      `\n## Médias por formato\n${lm.join("\n") || "(sem dados)"}`,
      `\n## Ideias salvas pela equipe (ainda não usadas)\n${li.join("\n") || "(nenhuma)"}`,
      `\n## Agenda dos próximos dias\n${la.join("\n") || "(nada marcado)"}`,
      `\n## Já planejado (não repetir)\n${lj.join("\n") || "(nada)"}`,
      le.length ? `\n## Evitar (a equipe pediu outra opção no lugar destes)\n${le.join("\n")}` : "",
    ].filter(Boolean).join("\n");

    const client = new Anthropic();
    const resp = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SISTEMA,
      messages: [{ role: "user", content: pedido }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    });

    if (resp.stop_reason === "refusal") return json({ ok: false, mensagem: "A IA não quis montar essa semana — tente outro pedido" }, 502);
    if (resp.stop_reason === "max_tokens") return json({ ok: false, mensagem: "A resposta ficou grande demais — tente menos dias" }, 502);
    const texto = resp.content.find((b) => b.type === "text");
    if (!texto || texto.type !== "text") return json({ ok: false, mensagem: "A IA não respondeu" }, 502);
    const plano = JSON.parse(texto.text);
    // só os dias pedidos, um post por dia, e só ideias que existem
    const validas = new Set((ideias.data || []).map((x) => x.id));
    const vistos = new Set<string>();
    plano.posts = (plano.posts || []).filter((p: { data: string; ideia_id: string }) => {
      if (!dias.includes(p.data) || vistos.has(p.data)) return false;
      vistos.add(p.data);
      if (p.ideia_id && !validas.has(p.ideia_id)) p.ideia_id = "";
      return true;
    });
    return json({ ok: true, ...plano });
  } catch (e) {
    return json({ ok: false, mensagem: (e as Error).message }, 500);
  }
});
