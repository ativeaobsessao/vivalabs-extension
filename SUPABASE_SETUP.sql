-- ═══════════════════════════════════════════════════════════════════════════════
-- VIVA SPY — COFRE COMPARTILHADO DA EQUIPE (Supabase, plano gratuito)
--
-- COMO USAR: Supabase → menu "SQL Editor" → "New query" → cole TUDO isto → "Run".
-- Pode rodar de novo sem medo (é seguro repetir).
--
-- ANTES de rodar, troque  __CODIGO_DA_EQUIPE__  (linha do INSERT lá embaixo) pelo código
-- que só a sua equipe vai conhecer. Esse código é a "senha" da equipe.
-- Para TROCAR o código depois (ex.: alguém saiu da equipe), rode apenas:
--   update public.viva_config set v = 'NOVO-CODIGO' where k = 'team_token';
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1) Configuração (guarda o código da equipe; ninguém de fora consegue ler)
create table if not exists public.viva_config (
  k text primary key,
  v text not null
);
alter table public.viva_config enable row level security;
revoke all on public.viva_config from anon, authenticated;

insert into public.viva_config (k, v)
values ('team_token', '__CODIGO_DA_EQUIPE__')
on conflict (k) do nothing;

-- 2) Criativos compartilhados
create sequence if not exists public.viva_seq;

create table if not exists public.viva_creatives (
  key        text primary key,                 -- identificador do criativo (id do anúncio ou assinatura)
  rec        jsonb not null,                   -- o registro completo (copy, página, dup, dias, score...)
  found_by   text not null default '',         -- quem achou primeiro
  found_ms   bigint not null default 0,
  status     text not null default 'nova',     -- nova | analise | minerada | descartada
  status_by  text not null default '',
  status_ms  bigint not null default 0,
  seq        bigint not null default nextval('public.viva_seq')   -- posição de leitura incremental
);
create index if not exists viva_creatives_seq_idx on public.viva_creatives (seq);
alter table public.viva_creatives enable row level security;
revoke all on public.viva_creatives from anon, authenticated;
-- (sem policies de propósito: ninguém acessa a tabela direto; só pelas funções abaixo,
--  que exigem o código da equipe)

-- 3) Verificação do código
create or replace function public._viva_ok(p_token text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_token is not null
     and length(p_token) >= 8
     and exists (select 1 from public.viva_config where k = 'team_token' and v = p_token);
$$;
revoke all on function public._viva_ok(text) from public, anon, authenticated;

-- 4) Enviar criativos (junta com o que já existe: maior dup/adv, menor firstSeen, maior lastSeen)
create or replace function public.viva_push(p_token text, p_by text, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  it     jsonb;
  r      jsonb;
  old    public.viva_creatives%rowtype;
  n      integer := 0;
  nowms  bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if not public._viva_ok(p_token) then
    raise exception 'codigo_invalido' using errcode = '28000';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'itens_invalidos';
  end if;

  for it in select value from jsonb_array_elements(p_items) limit 300 loop
    if coalesce(it->>'key', '') = '' or jsonb_typeof(it->'rec') <> 'object' then
      continue;
    end if;
    r := it->'rec';
    if length(r::text) > 8000 then
      continue;
    end if;

    select * into old from public.viva_creatives where key = it->>'key';
    if not found then
      insert into public.viva_creatives (key, rec, found_by, found_ms, seq)
      values (it->>'key', r, left(coalesce(p_by, ''), 40), nowms, nextval('public.viva_seq'));
    else
      r := r || jsonb_build_object(
        'dup',       greatest(coalesce(nullif(r->>'dup', '')::numeric, 1), coalesce(nullif(old.rec->>'dup', '')::numeric, 1)),
        'adv',       greatest(coalesce(nullif(r->>'adv', '')::numeric, 0), coalesce(nullif(old.rec->>'adv', '')::numeric, 0)),
        'firstSeen', least(coalesce(nullif(r->>'firstSeen', '')::numeric, nowms), coalesce(nullif(old.rec->>'firstSeen', '')::numeric, nowms)),
        'lastSeen',  greatest(coalesce(nullif(r->>'lastSeen', '')::numeric, 0), coalesce(nullif(old.rec->>'lastSeen', '')::numeric, 0))
      );
      update public.viva_creatives
         set rec = r, seq = nextval('public.viva_seq')
       where key = old.key;
    end if;
    n := n + 1;
  end loop;

  -- Faxina: criativos sem novidade há 45 dias e sem etiqueta de trabalho saem do cofre.
  delete from public.viva_creatives
   where status in ('nova', 'descartada')
     and coalesce(nullif(rec->>'lastSeen', '')::numeric, 0) < nowms - 45::bigint * 86400000;

  return n;
end;
$$;

-- 5) Ler novidades desde a última posição
create or replace function public.viva_pull(p_token text, p_since bigint default 0, p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  resultado jsonb;
begin
  if not public._viva_ok(p_token) then
    raise exception 'codigo_invalido' using errcode = '28000';
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.seq), '[]'::jsonb)
    into resultado
    from (
      select key, rec, found_by as "by", status, status_by as "statusBy", status_ms as "statusMs", seq
        from public.viva_creatives
       where seq > coalesce(p_since, 0)
       order by seq asc
       limit least(greatest(coalesce(p_limit, 500), 1), 1000)
    ) x;

  return resultado;
end;
$$;

-- 6) Mudar a etiqueta de trabalho (vale a mais recente)
create or replace function public.viva_set_status(p_token text, p_key text, p_status text, p_by text, p_ms bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  atualizou integer;
begin
  if not public._viva_ok(p_token) then
    raise exception 'codigo_invalido' using errcode = '28000';
  end if;
  if p_status not in ('nova', 'analise', 'minerada', 'descartada') then
    raise exception 'status_invalido';
  end if;

  update public.viva_creatives
     set status = p_status,
         status_by = left(coalesce(p_by, ''), 40),
         status_ms = coalesce(p_ms, 0),
         seq = nextval('public.viva_seq')
   where key = p_key
     and coalesce(p_ms, 0) >= status_ms;
  get diagnostics atualizou = row_count;
  return atualizou > 0;
end;
$$;

-- 7) Teste rápido do código (a extensão usa no botão "Testar conexão")
create or replace function public.viva_check(p_token text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public._viva_ok(p_token);
$$;

-- 8) Permissões: só estas 4 funções ficam abertas (e todas exigem o código)
revoke all on function public.viva_push(text, text, jsonb) from public;
revoke all on function public.viva_pull(text, bigint, integer) from public;
revoke all on function public.viva_set_status(text, text, text, text, bigint) from public;
revoke all on function public.viva_check(text) from public;
grant execute on function public.viva_push(text, text, jsonb) to anon, authenticated;
grant execute on function public.viva_pull(text, bigint, integer) to anon, authenticated;
grant execute on function public.viva_set_status(text, text, text, text, bigint) to anon, authenticated;
grant execute on function public.viva_check(text) to anon, authenticated;
