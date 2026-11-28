-- ═══════════════════════════════════════════════════════════════════════════════
-- VIVA SPY — ATUALIZAÇÃO "150 MIL ANÚNCIOS" (rodar DEPOIS do SUPABASE_SETUP.sql)
--
-- COMO USAR: Supabase → "SQL Editor" → "New query" → cole TUDO isto → "Run".
-- Pode rodar de novo sem medo. Não precisa trocar nada no texto: o código da equipe continua o mesmo.
--
-- O que muda:
--   • o Centro de Inteligência passa a filtrar, ordenar e paginar DENTRO do banco;
--   • a faxina automática de 45 dias é DESLIGADA: nada mais é apagado sozinho;
--   • apagar de verdade passa a valer para a equipe inteira (o item não volta).
-- Nenhum anúncio já salvo é apagado ao rodar este arquivo.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

alter table public.viva_creatives add column if not exists niche_manual text;

-- Lista do que foi apagado para sempre (criativo, página 'p:', nome 'n:' ou domínio 'd:').
create table if not exists public.viva_removidos (
  alvo text primary key,
  ms   bigint not null default 0
);
alter table public.viva_removidos enable row level security;
revoke all on public.viva_removidos from anon, authenticated;

-- Ficha enxuta de cada criativo, usada para filtrar/ordenar rápido. É derivada de viva_creatives.
create table if not exists public.viva_indice (
  key        text primary key references public.viva_creatives (key) on delete cascade,
  pid        text    not null default '',
  nome       text    not null default '',
  dom        text    not null default '',   -- domínio da oferta ('' quando não é uma oferta)
  texto      text    not null default '',   -- trecho do anúncio, para a busca
  dup        integer not null default 1,
  adv        integer not null default 0,
  base_adv   integer not null default 0,
  inicio     bigint  not null default 0,
  dias_lidos integer,                       -- usado quando não há data de início
  video      boolean not null default false,
  nicho      text    not null default 'Outro',
  fontes     text[]  not null default '{}',
  quem       text    not null default '',
  status     text    not null default 'nova',
  visto_ms   bigint  not null default 0
);
alter table public.viva_indice enable row level security;
revoke all on public.viva_indice from anon, authenticated;

create or replace function public._viva_agora()
returns bigint language sql volatile as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;

-- Número vindo do registro: texto estranho nunca derruba o envio.
create or replace function public._viva_num(p text, p_padrao bigint)
returns bigint language sql immutable as $$
  select case when p ~ '^[0-9]{1,15}(\.[0-9]+)?$' then round(p::numeric)::bigint else p_padrao end;
$$;

create or replace function public._viva_dominio(p text)
returns text language sql immutable as $$
  select case
           when d !~ '\.' then ''
           when d ~ '(^|\.)(facebook\.com|fb\.com|fb\.me|fb\.watch|instagram\.com|messenger\.com|whatsapp\.com|wa\.me|m\.me|youtube\.com|youtu\.be|tiktok\.com|linktr\.ee|bit\.ly|tinyurl\.com|t\.me|google\.com|apps\.apple\.com|twitter\.com|x\.com)$' then ''
           else d
         end
    from (select regexp_replace(
                   split_part(split_part(split_part(
                     regexp_replace(lower(btrim(coalesce(p, ''))), '^https?://', ''),
                   '/', 1), '?', 1), '#', 1),
                 '^www\.', '') as d) x;
$$;

-- Nicho por palavras (a mesma lista de intel_core.js).
create or replace function public._viva_nicho(p text)
returns text language sql immutable as $$
  select case
    when t ~ '(^|[^[:alnum:]])(diabet|blood sugar|glucose|insulin|a1c|glicose|glicemia)' then 'Diabetes'
    when t ~ '(^|[^[:alnum:]])(menopaus|perimenopaus|hot flash|fogacho|calorões)' then 'Menopausa'
    when t ~ '(^|[^[:alnum:]])(weight|fat burn|belly|slimming|ozempic|mounjaro|glp-?1|keto|metabolism|emagrec|perder peso|gordura|barriga)' then 'Emagrecimento'
    when t ~ '(^|[^[:alnum:]])(relationship|your ex|get him back|get her back|seduc|seduç|marriage|dating|relacionamento|reconquist|casamento)' then 'Relacionamento'
    when t ~ '(^|[^[:alnum:]])(make money|side hustle|passive income|work from home|extra income|renda extra|ganhar dinheiro|trabalhar em casa)' then 'Renda extra'
    when t ~ '(^|[^[:alnum:]])(wrinkle|anti-?aging|collagen|younger|rejuvenesc|ruga|colágeno|skin)' then 'Rejuvenescimento'
    else 'Outro'
  end
  from (select lower(coalesce(p, '')) as t) x;
$$;

create or replace function public._viva_linha(c public.viva_creatives)
returns public.viva_indice language plpgsql stable as $$
declare
  r      jsonb := c.rec;
  linha  public.viva_indice;
  termos text;
begin
  linha.key := c.key;
  linha.pid := left(coalesce(r->>'pid', ''), 20);
  linha.nome := left(coalesce(r->>'nome', ''), 120);
  linha.dom := public._viva_dominio(coalesce(nullif(r->>'dom', ''), r->>'dest'));
  linha.texto := left(coalesce(r->>'copy', ''), 120);
  linha.dup := greatest(1, least(9999, public._viva_num(r->>'dup', 1)))::integer;
  linha.adv := least(999999, public._viva_num(r->>'adv', 0))::integer;
  linha.base_adv := least(999999, public._viva_num(r->>'advBase', 0))::integer;
  linha.inicio := public._viva_num(r->>'inicio', 0);
  linha.dias_lidos := least(36500, public._viva_num(r->>'dias', null))::integer;
  if public._viva_num(r->>'dias', null) is null then linha.dias_lidos := null; end if;
  linha.video := coalesce(r->>'video', '') = 'true';
  select coalesce(array_agg(left(f.v, 80) order by f.o), '{}') into linha.fontes
    from jsonb_array_elements_text(case when jsonb_typeof(r->'fontes') = 'array' then r->'fontes' else '[]'::jsonb end)
         with ordinality as f(v, o)
   where f.o <= 20;
  termos := array_to_string(linha.fontes, ' ');
  linha.nicho := coalesce(
    c.niche_manual,
    nullif(public._viva_nicho(termos), 'Outro'),
    public._viva_nicho(concat_ws(' ', r->>'nome', r->>'copy', r->>'dom')));
  linha.quem := c.found_by;
  linha.status := c.status;
  linha.visto_ms := public._viva_num(r->>'firstSeen', c.found_ms);
  return linha;
end;
$$;

create or replace function public._viva_indexar()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  l public.viva_indice := public._viva_linha(new);
begin
  insert into public.viva_indice as i values (l.*)
  on conflict (key) do update set
    pid = excluded.pid, nome = excluded.nome, dom = excluded.dom, texto = excluded.texto,
    dup = excluded.dup, adv = excluded.adv, base_adv = excluded.base_adv, inicio = excluded.inicio,
    dias_lidos = excluded.dias_lidos, video = excluded.video, nicho = excluded.nicho,
    fontes = excluded.fontes, quem = excluded.quem, status = excluded.status, visto_ms = excluded.visto_ms
  where i.* is distinct from excluded.*;
  return null;
end;
$$;

drop trigger if exists viva_indice_trg on public.viva_creatives;
create trigger viva_indice_trg after insert or update on public.viva_creatives
  for each row execute function public._viva_indexar();

-- O que foi apagado para sempre não entra de novo (nem pelo envio de uma versão antiga da extensão).
create or replace function public._viva_barrar()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.viva_removidos
     where alvo in (
       new.key,
       'p:' || coalesce(new.rec->>'pid', ''),
       'n:' || case when coalesce(new.rec->>'pid', '') = '' then lower(coalesce(new.rec->>'nome', '')) else '' end,
       'd:' || public._viva_dominio(coalesce(nullif(new.rec->>'dom', ''), new.rec->>'dest')))
  ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists viva_barrar_trg on public.viva_creatives;
create trigger viva_barrar_trg before insert on public.viva_creatives
  for each row execute function public._viva_barrar();

-- Monta as fichas do que já existe (a tabela de fichas é derivada: pode ser refeita à vontade).
delete from public.viva_indice;
insert into public.viva_indice
select l.* from public.viva_creatives c, lateral public._viva_linha(c) l;

-- Envio de criativos: igual ao anterior, SEM a faxina automática.
create or replace function public.viva_push(p_token text, p_by text, p_items jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare
  it     jsonb;
  r      jsonb;
  old    public.viva_creatives%rowtype;
  n      integer := 0;
  nowms  bigint := public._viva_agora();
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
      if coalesce(nullif(old.rec->>'advBaseMs', '')::numeric, 0) > coalesce(nullif(r->>'advBaseMs', '')::numeric, 0) then
        r := r || jsonb_build_object(
          'advBase',   coalesce(nullif(old.rec->>'advBase', '')::numeric, 0),
          'advBaseMs', coalesce(nullif(old.rec->>'advBaseMs', '')::numeric, 0)
        );
      end if;
      update public.viva_creatives set rec = r, seq = nextval('public.viva_seq') where key = old.key;
    end if;
    n := n + 1;
  end loop;

  return n;
end;
$$;

create or replace function public._viva_exigir(p_token text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public._viva_ok(p_token) then
    raise exception 'codigo_invalido' using errcode = '28000';
  end if;
end;
$$;

-- Filtros do Centro (um só lugar). Score e selo = mesmas regras de ranking_engine.js / intel_core.js.
create or replace function public._viva_filtrar(f jsonb, p_agora bigint)
returns table (
  key text, score integer, score_base integer, dias integer, selo text, dup integer, adv integer,
  pid text, nome text, dom text, nicho text, visto_ms bigint, subindo boolean, fontes text[])
language sql stable as $$
  select i.key,
         b.base + least(greatest(cardinality(i.fontes) - 1, 0), 6) * 8,
         b.base,
         d.dias,
         case when e.agora then 'agora' when d.dias >= 30 then 'monstro'
              when d.dias >= 15 or i.dup >= 3 then 'bruta' else '' end,
         i.dup, i.adv, i.pid, i.nome, i.dom, i.nicho, i.visto_ms, s.sobe, i.fontes
    from public.viva_indice i
    cross join lateral (select case when i.inicio > 0
           then greatest(0, ceil((p_agora - i.inicio) / 86400000.0))::integer
           else i.dias_lidos end as dias) d
    cross join lateral (select coalesce((d.dias <= 7 and i.dup >= 4) or (d.dias <= 14 and i.dup >= 8), false) as agora) e
    cross join lateral (select least(i.dup, 50) * 4 + least(coalesce(d.dias, 0), 60) + least(i.adv, 40)
           + case when not e.agora then 0 when d.dias <= 7 and i.dup >= 4 then 40 else 60 end as base) b
    cross join lateral (select i.base_adv > 0 and i.adv - i.base_adv >= 5 and i.adv >= i.base_adv * 1.3 as sobe) s
   where case coalesce(f->>'status', 'ativas')
           when 'ativas' then i.status <> 'descartada'
           when 'todas' then true
           else i.status = f->>'status' end
     and case coalesce(f->>'escala', 'todos')
           when 'agora' then e.agora
           when 'monstro' then not e.agora and coalesce(d.dias >= 30, false)
           when 'bruta' then not e.agora and not coalesce(d.dias >= 30, false) and (coalesce(d.dias >= 15, false) or i.dup >= 3)
           else true end
     and case coalesce(f->>'dias', '')
           when '1-7' then d.dias <= 7
           when '8-14' then d.dias between 8 and 14
           when '15-29' then d.dias between 15 and 29
           when '30+' then d.dias >= 30
           else true end
     and (coalesce(f->>'nicho', '') = '' or i.nicho = f->>'nicho')
     and case coalesce(f->>'formato', '') when 'video' then i.video when 'imagem' then not i.video else true end
     and (coalesce(f->>'busca', '') = '' or position(lower(f->>'busca') in lower(i.nome || ' ' || i.dom || ' ' || i.texto)) > 0)
     and i.dup >= public._viva_num(f->>'copiasMin', 0)
     and i.adv >= public._viva_num(f->>'advMin', 0)
     and (coalesce(f->>'termo', '') = '' or i.fontes @> array[f->>'termo'])
     and (coalesce(f->>'quem', '') = '' or i.quem = f->>'quem')
     and (coalesce(f->>'novos24', '') <> 'true' or i.visto_ms >= p_agora - 86400000)
     and (coalesce(f->>'subindo', '') <> 'true' or s.sobe)
     and (coalesce(f->>'pid', '') = '' or i.pid = f->>'pid')
     and (coalesce(f->>'nomeExato', '') = '' or (i.pid = '' and lower(i.nome) = lower(f->>'nomeExato')))
     and (coalesce(f->>'dom', '') = '' or i.dom = f->>'dom');
$$;

create or replace function public.viva_buscar(
  p_token text, p_filtros jsonb default '{}'::jsonb, p_ordem text default 'score',
  p_pagina integer default 0, p_tamanho integer default 48)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_agora bigint := public._viva_agora();
  v_tam   integer := greatest(1, least(coalesce(p_tamanho, 48), 200));
  v_f     jsonb := coalesce(p_filtros, '{}'::jsonb);
  v_total bigint;
  v_itens jsonb;
begin
  perform public._viva_exigir(p_token);
  select count(*) into v_total from public._viva_filtrar(v_f, v_agora);
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', c.key, 'rec', c.rec, 'by', c.found_by, 'status', c.status, 'statusBy', c.status_by,
           'score', t.score, 'dias', t.dias, 'selo', t.selo, 'nicho', t.nicho) order by t.rn), '[]'::jsonb)
    into v_itens
    from (
      select x.*, row_number() over () as rn
        from (
          select f.key, f.score, f.dias, f.selo, f.nicho
            from public._viva_filtrar(v_f, v_agora) f
           order by
             case when p_ordem = 'dup' then f.dup end desc nulls last,
             case when p_ordem = 'dias' then f.dias end desc nulls last,
             case when p_ordem = 'novos' then f.dias end asc nulls last,
             case when p_ordem = 'menor' then f.score end asc nulls last,
             f.score desc, f.key
          offset greatest(coalesce(p_pagina, 0), 0) * v_tam
           limit v_tam
        ) x
    ) t
    join public.viva_creatives c on c.key = t.key;
  return jsonb_build_object('total', v_total, 'itens', v_itens);
end;
$$;

-- Chaves de tudo que passa nos filtros (para ações em lote), até 20 mil por vez.
create or replace function public.viva_chaves(p_token text, p_filtros jsonb default '{}'::jsonb, p_limite integer default 5000)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_res jsonb;
begin
  perform public._viva_exigir(p_token);
  select coalesce(jsonb_agg(x.key), '[]'::jsonb) into v_res
    from (select f.key from public._viva_filtrar(coalesce(p_filtros, '{}'::jsonb), public._viva_agora()) f
           order by f.score desc, f.key
           limit greatest(1, least(coalesce(p_limite, 5000), 20000))) x;
  return v_res;
end;
$$;

-- Abas Ofertas (por domínio) e Bibliotecas (por página).
create or replace function public.viva_grupos(
  p_token text, p_tipo text, p_filtros jsonb default '{}'::jsonb,
  p_pagina integer default 0, p_tamanho integer default 48)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_agora bigint := public._viva_agora();
  v_tam   integer := greatest(1, least(coalesce(p_tamanho, 48), 200));
  v_res   jsonb;
begin
  perform public._viva_exigir(p_token);
  if p_tipo not in ('ofertas', 'paginas') then
    raise exception 'tipo_invalido';
  end if;
  with base as (
    select case when p_tipo = 'ofertas' then f.dom
                when f.pid <> '' then f.pid else 'n:' || lower(f.nome) end as grupo, f.*
      from public._viva_filtrar(coalesce(p_filtros, '{}'::jsonb), v_agora) f
     where p_tipo = 'paginas' or f.dom <> ''
  ), g as (
    select grupo,
           count(*) as criativos,
           count(*) filter (where selo = 'agora') as em_escala,
           max(dup) as max_dup,
           coalesce(round(avg(dias)), 0) as media_dias,
           max(adv) as adv,
           max(score_base) as top_score,
           count(*) filter (where visto_ms >= v_agora - 86400000) as novos24,
           count(*) filter (where subindo) as subindo,
           count(distinct case when pid <> '' then pid else 'n:' || lower(nome) end) as paginas
      from base group by grupo
  ), ordenado as (
    select g.*,
           (top_score + least(criativos, 20) * 3 + em_escala * 10
            + case when p_tipo = 'ofertas'
                   then least(paginas, 10) * 8 + least(novos24, 5) * 2 + least(subindo, 5) * 5 else 0 end) as score
      from g
  ), pagina as (
    select * from ordenado order by score desc, criativos desc, grupo
    offset greatest(coalesce(p_pagina, 0), 0) * v_tam limit v_tam
  ), melhor as (
    select distinct on (b.grupo) b.grupo, b.key, b.pid, b.nome
      from base b join pagina p on p.grupo = b.grupo
     order by b.grupo, b.score desc, b.key
  )
  select jsonb_build_object(
    'total', (select count(*) from g),
    'itens', coalesce((
      select jsonb_agg(jsonb_build_object(
        'grupo', p.grupo, 'criativos', p.criativos, 'emEscala', p.em_escala, 'maxDup', p.max_dup,
        'mediaDias', p.media_dias, 'adv', p.adv, 'paginas', p.paginas, 'score', p.score,
        'pid', m.pid, 'nome', m.nome,
        'thumb', coalesce(c.rec->>'thumb', ''), 'dest', coalesce(c.rec->>'dest', '')
      ) order by p.score desc, p.criativos desc, p.grupo)
      from pagina p
      join melhor m on m.grupo = p.grupo
      join public.viva_creatives c on c.key = m.key), '[]'::jsonb))
    into v_res;
  return v_res;
end;
$$;

-- Uso do banco (contador "X de 150 mil").
create or replace function public.viva_info(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public._viva_exigir(p_token);
  return jsonb_build_object(
    'versao', 2,
    'total', (select count(*) from public.viva_indice),
    'descartados', (select count(*) from public.viva_indice where status = 'descartada'),
    'bloqueados', (select count(*) from public.viva_removidos),
    'bytes', pg_database_size(current_database()));
end;
$$;

create or replace function public.viva_opcoes(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public._viva_exigir(p_token);
  return jsonb_build_object(
    'termos', coalesce((select jsonb_agg(x.t) from (
        select t from public.viva_indice, unnest(fontes) t group by t order by count(*) desc, t limit 60) x), '[]'::jsonb),
    'quem', coalesce((select jsonb_agg(x.quem) from (
        select quem from public.viva_indice where quem <> '' group by quem order by quem limit 40) x), '[]'::jsonb));
end;
$$;

create or replace function public.viva_marcar(p_token text, p_keys jsonb, p_status text, p_by text)
returns integer language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  perform public._viva_exigir(p_token);
  if p_status not in ('nova', 'analise', 'minerada', 'descartada') then
    raise exception 'status_invalido';
  end if;
  update public.viva_creatives
     set status = p_status, status_by = left(coalesce(p_by, ''), 40),
         status_ms = public._viva_agora(), seq = nextval('public.viva_seq')
   where key in (select value from jsonb_array_elements_text(p_keys) limit 1000);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Apagar para sempre (libera espaço; não volta a entrar).
create or replace function public.viva_apagar(p_token text, p_keys jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_keys text[];
  n      integer;
begin
  perform public._viva_exigir(p_token);
  select coalesce(array_agg(value), '{}') into v_keys
    from (select value from jsonb_array_elements_text(p_keys) limit 1000) x;
  insert into public.viva_removidos (alvo, ms)
  select k, public._viva_agora() from unnest(v_keys) k where k <> ''
  on conflict (alvo) do nothing;
  delete from public.viva_creatives where key = any (v_keys);
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.viva_apagar_descartados(p_token text, p_limite integer default 2000)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_keys text[];
  n      integer;
begin
  perform public._viva_exigir(p_token);
  select coalesce(array_agg(key), '{}') into v_keys
    from (select key from public.viva_indice where status = 'descartada'
           limit greatest(1, least(coalesce(p_limite, 2000), 5000))) x;
  insert into public.viva_removidos (alvo, ms)
  select k, public._viva_agora() from unnest(v_keys) k
  on conflict (alvo) do nothing;
  delete from public.viva_creatives where key = any (v_keys);
  get diagnostics n = row_count;
  return jsonb_build_object('apagados', n,
    'restam', (select count(*) from public.viva_indice where status = 'descartada'));
end;
$$;

-- Bloquear anunciante/oferta para a equipe inteira (apaga o que existe dele e não deixa voltar).
create or replace function public.viva_bloquear(p_token text, p_alvo text)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_tipo  text := left(coalesce(p_alvo, ''), 2);
  v_valor text := substr(coalesce(p_alvo, ''), 3);
  n       integer;
begin
  perform public._viva_exigir(p_token);
  if v_tipo not in ('p:', 'n:', 'd:') or btrim(v_valor) = '' or length(v_valor) > 200 then
    raise exception 'alvo_invalido';
  end if;
  insert into public.viva_removidos (alvo, ms) values (v_tipo || lower(v_valor), public._viva_agora())
  on conflict (alvo) do nothing;
  delete from public.viva_creatives where key in (
    select key from public.viva_indice
     where (v_tipo = 'p:' and pid = v_valor)
        or (v_tipo = 'n:' and pid = '' and lower(nome) = lower(v_valor))
        or (v_tipo = 'd:' and dom = lower(v_valor)));
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.viva_desbloquear(p_token text)
returns integer language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  perform public._viva_exigir(p_token);
  delete from public.viva_removidos where alvo <> '';
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.viva_definir_nicho(p_token text, p_key text, p_nicho text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  perform public._viva_exigir(p_token);
  if p_nicho is not null and p_nicho not in
     ('Emagrecimento', 'Diabetes', 'Menopausa', 'Renda extra', 'Rejuvenescimento', 'Relacionamento', 'Outro') then
    raise exception 'nicho_invalido';
  end if;
  update public.viva_creatives set niche_manual = p_nicho, seq = nextval('public.viva_seq') where key = p_key;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- Permissões: funções internas fechadas; as do Centro abertas (todas exigem o código da equipe).
revoke all on function public._viva_agora() from public, anon, authenticated;
revoke all on function public._viva_num(text, bigint) from public, anon, authenticated;
revoke all on function public._viva_dominio(text) from public, anon, authenticated;
revoke all on function public._viva_nicho(text) from public, anon, authenticated;
revoke all on function public._viva_linha(public.viva_creatives) from public, anon, authenticated;
revoke all on function public._viva_indexar() from public, anon, authenticated;
revoke all on function public._viva_barrar() from public, anon, authenticated;
revoke all on function public._viva_exigir(text) from public, anon, authenticated;
revoke all on function public._viva_filtrar(jsonb, bigint) from public, anon, authenticated;

revoke all on function public.viva_buscar(text, jsonb, text, integer, integer) from public;
revoke all on function public.viva_chaves(text, jsonb, integer) from public;
revoke all on function public.viva_grupos(text, text, jsonb, integer, integer) from public;
revoke all on function public.viva_info(text) from public;
revoke all on function public.viva_opcoes(text) from public;
revoke all on function public.viva_marcar(text, jsonb, text, text) from public;
revoke all on function public.viva_apagar(text, jsonb) from public;
revoke all on function public.viva_apagar_descartados(text, integer) from public;
revoke all on function public.viva_bloquear(text, text) from public;
revoke all on function public.viva_desbloquear(text) from public;
revoke all on function public.viva_definir_nicho(text, text, text) from public;

grant execute on function public.viva_buscar(text, jsonb, text, integer, integer) to anon, authenticated;
grant execute on function public.viva_chaves(text, jsonb, integer) to anon, authenticated;
grant execute on function public.viva_grupos(text, text, jsonb, integer, integer) to anon, authenticated;
grant execute on function public.viva_info(text) to anon, authenticated;
grant execute on function public.viva_opcoes(text) to anon, authenticated;
grant execute on function public.viva_marcar(text, jsonb, text, text) to anon, authenticated;
grant execute on function public.viva_apagar(text, jsonb) to anon, authenticated;
grant execute on function public.viva_apagar_descartados(text, integer) to anon, authenticated;
grant execute on function public.viva_bloquear(text, text) to anon, authenticated;
grant execute on function public.viva_desbloquear(text) to anon, authenticated;
grant execute on function public.viva_definir_nicho(text, text, text) to anon, authenticated;

commit;

notify pgrst, 'reload schema';

-- Conferência (aparece no resultado do "Run"): quantos anúncios há e quanto espaço o banco ocupa.
select count(*) as anuncios, pg_size_pretty(pg_database_size(current_database())) as banco
  from public.viva_creatives;
