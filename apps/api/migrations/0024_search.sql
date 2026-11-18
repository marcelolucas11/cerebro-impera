-- =============================================================================
-- Global search. Nothing here decides who sees what: the search reads items
-- through the same row-level rules as everything else, so it finds only what
-- the caller could open anyway. This only makes "acao" find "Ação".
-- =============================================================================

-- Lowercase, without the accents of Portuguese and Spanish.
CREATE FUNCTION app.plain(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT translate(lower(p_text),
                   'áàâãäåéèêëíìîïóòôõöúùûüçñý',
                   'aaaaaaeeeeiiiiooooouuuucny')
$$;

CREATE INDEX items_plain_title_idx ON app.items (app.plain(title) text_pattern_ops);

GRANT EXECUTE ON FUNCTION app.plain(text) TO cerebro_app;
