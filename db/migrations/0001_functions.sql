create or replace function new_id(prefix text) returns text
language sql volatile as $$
  select prefix || '_' || replace(gen_random_uuid()::text, '-', '')
$$;

create or replace function fmt_ts(ts timestamptz) returns text
language sql immutable as $$
  select to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- Mirrors canonicalJson() in src/domain/canonical.ts. Keys bytewise, no
-- whitespace, strings escaped as JSON, integers only. Both sides are pinned
-- to the same test vectors.
create or replace function canonical_json(j jsonb) returns text
language plpgsql immutable as $$
declare
  t text := jsonb_typeof(j);
  parts text[] := '{}';
  k text;
  v jsonb;
begin
  if t = 'object' then
    for k, v in select key, value from jsonb_each(j) order by key collate "C" loop
      parts := parts || (to_json(k)::text || ':' || canonical_json(v));
    end loop;
    return '{' || array_to_string(parts, ',') || '}';
  elsif t = 'array' then
    for v in select value from jsonb_array_elements(j) loop
      parts := parts || canonical_json(v);
    end loop;
    return '[' || array_to_string(parts, ',') || ']';
  elsif t = 'string' then
    return to_json(j #>> '{}')::text;
  elsif t = 'number' then
    if (j::text) ~ '[.eE]' then
      raise exception 'canonical_json permits only integer numbers';
    end if;
    return j::text;
  elsif t = 'boolean' then
    return j::text;
  else
    return 'null';
  end if;
end $$;
