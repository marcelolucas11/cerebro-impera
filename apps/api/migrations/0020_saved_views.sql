-- =============================================================================
-- Saved views: a name for a way of looking at a list (list or board, a filter
-- and an order), kept per person. A view holds no data and grants nothing: it
-- is the text of an address, read back only by whoever saved it, and only
-- while they can still open the list.
-- =============================================================================

CREATE TABLE app.saved_views (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  list_id    uuid NOT NULL REFERENCES app.lists (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60 AND name = btrim(name)
                                  AND name !~ '[[:cntrl:]]'),
  kind       text NOT NULL CHECK (kind IN ('list', 'board')),
  -- The query part of an address, exactly as the page writes it, or nothing.
  query      text NOT NULL CHECK (length(query) <= 2000
                                  AND query ~ '^(\?[A-Za-z0-9%._~:=&+-]*)?$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX saved_views_name_key ON app.saved_views (user_id, list_id, lower(name));

CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.saved_views
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('user_id');

-- A view stays with its person and its list, and a person keeps a sensible
-- number of them per list.
CREATE FUNCTION app.saved_views_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.list_id <> OLD.list_id OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'a view stays with its list' USING ERRCODE = 'CB003';
    END IF;
  ELSIF (SELECT count(*) FROM app.saved_views v
         WHERE v.user_id = NEW.user_id AND v.list_id = NEW.list_id) >= 30 THEN
    RAISE EXCEPTION 'too many views on this list' USING ERRCODE = 'CB003';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER keep BEFORE INSERT OR UPDATE ON app.saved_views
  FOR EACH ROW EXECUTE FUNCTION app.saved_views_guard();

ALTER TABLE app.saved_views ENABLE ROW LEVEL SECURITY;

-- One's own views, of lists one can still open. Nobody else's, not even an
-- owner's reach: they are a person's way of working, not company data.
CREATE POLICY saved_views_select ON app.saved_views FOR SELECT TO cerebro_app
  USING (user_id = authz.uid() AND authz.list_level(list_id) >= 'view');
CREATE POLICY saved_views_insert ON app.saved_views FOR INSERT TO cerebro_app
  WITH CHECK (user_id = authz.uid() AND authz.list_level(list_id) >= 'view');
CREATE POLICY saved_views_update ON app.saved_views FOR UPDATE TO cerebro_app
  USING (user_id = authz.uid() AND authz.list_level(list_id) >= 'view')
  WITH CHECK (user_id = authz.uid() AND authz.list_level(list_id) >= 'view');
CREATE POLICY saved_views_delete ON app.saved_views FOR DELETE TO cerebro_app
  USING (user_id = authz.uid());

GRANT SELECT ON app.saved_views TO cerebro_app;
GRANT INSERT (id, list_id, name, kind, query), UPDATE (name, kind, query), DELETE
  ON app.saved_views TO cerebro_app;

REVOKE EXECUTE ON FUNCTION app.saved_views_guard() FROM PUBLIC;
