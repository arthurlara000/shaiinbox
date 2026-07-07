-- Rodar no Supabase > SQL Editor quando o serviço voltar
-- https://supabase.com/dashboard/project/ofoljmhfnohxwswskplx/sql

CREATE TABLE IF NOT EXISTS public.despesas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loja text NOT NULL,
  data_despesa date NOT NULL DEFAULT CURRENT_DATE,
  descricao text NOT NULL,
  categoria text NOT NULL,
  valor numeric(12,2) NOT NULL,
  foto_url text,
  criado_em timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fechamento_dia (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loja text NOT NULL,
  data_fechamento date NOT NULL,
  total_loja numeric(12,2) NOT NULL DEFAULT 0,
  criado_em timestamptz DEFAULT now(),
  UNIQUE(loja, data_fechamento)
);

CREATE TABLE IF NOT EXISTS public.fechamento_vendedoras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fechamento_id uuid REFERENCES public.fechamento_dia(id) ON DELETE CASCADE,
  funcionaria_id uuid REFERENCES public.funcionarias(id) ON DELETE SET NULL,
  valor numeric(12,2) NOT NULL DEFAULT 0,
  criado_em timestamptz DEFAULT now()
);

ALTER TABLE public.despesas DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.fechamento_dia DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.fechamento_vendedoras DISABLE ROW LEVEL SECURITY;

-- Storage bucket para fotos de notas (criar em Storage > New bucket)
-- Nome: notas-despesas
-- Public: sim

-- ─── CALENDÁRIO: eventos da loja ───────────────────────
CREATE TABLE IF NOT EXISTS public.eventos_loja (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data        date NOT NULL,
  titulo      text NOT NULL,
  descricao   text,
  cor         text DEFAULT '#7c93a6',
  criado_em   timestamptz DEFAULT now()
);

ALTER TABLE public.eventos_loja DISABLE ROW LEVEL SECURITY;
