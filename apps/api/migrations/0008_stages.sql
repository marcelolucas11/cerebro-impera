-- =============================================================================
-- Stages ("etapas"). Every list has its own ordered set of stages, every item
-- is always in exactly one of them, and the database itself records how long
-- an item stays in each one.
-- =============================================================================

CREATE TYPE app.stage_kind AS ENUM ('open', 'active', 'done', 'closed');

CREATE TABLE app.list_stages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id    uuid NOT NULL REFERENCES app.lists (id),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  color      text NOT NULL DEFAULT '#9ba6b8' CHECK (color ~ '^#[0-9a-f]{6}$'),
  -- What the stage means for reports: not started, in progress, finished, or
  -- closed without finishing. The name is free; this is what totals rely on.
  kind       app.stage_kind NOT NULL DEFAULT 'active',
  position   integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES app.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Lets an item point at (list, stage) together, so its stage can only ever
  -- be one of its own list's.
  UNIQUE (list_id, id)
);
CREATE UNIQUE INDEX list_stages_name_idx ON app.list_stages (list_id, lower(name));
CREATE INDEX list_stages_order_idx ON app.list_stages (list_id, position);

-- Lists that already exist get a plain starting set.
INSERT INTO app.list_stages (list_id, name, color, kind, position, created_by)
SELECT l.id, d.name, d.color, d.kind::app.stage_kind, d.position, l.created_by
FROM app.lists l
CROSS JOIN (VALUES
  ('A fazer', '#9ba6b8', 'open', 0),
  ('Fazendo', '#dba63f', 'active', 1),
  ('Feito',   '#58b98a', 'done', 2)
) AS d (name, color, kind, position);

ALTER TABLE app.items
  ADD COLUMN stage_id uuid,
  ADD COLUMN stage_since timestamptz NOT NULL DEFAULT now();

ALTER TABLE app.items DISABLE TRIGGER touch;
UPDATE app.items i
SET stage_id = (SELECT s.id FROM app.list_stages s
                WHERE s.list_id = i.list_id ORDER BY s.position LIMIT 1),
    stage_since = i.created_at;
ALTER TABLE app.items ENABLE TRIGGER touch;

ALTER TABLE app.items
  ALTER COLUMN stage_id SET NOT NULL,
  ADD CONSTRAINT items_stage_fk FOREIGN KEY (list_id, stage_id)
    REFERENCES app.list_stages (list_id, id);
CREATE INDEX items_stage_idx ON app.items (stage_id);

-- One row per stay of an item in a stage. The stage name is copied, so the
-- history still reads right after a stage is renamed or removed.
CREATE TABLE app.item_stage_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id    uuid NOT NULL REFERENCES app.items (id) ON DELETE CASCADE,
  stage_id   uuid NOT NULL,
  stage_name text NOT NULL,
  entered_at timestamptz NOT NULL DEFAULT now(),
  left_at    timestamptz,
  moved_by   uuid REFERENCES app.users (id),
  CHECK (left_at IS NULL OR left_at >= entered_at)
);
CREATE INDEX item_stage_history_item_idx ON app.item_stage_history (item_id, entered_at);
-- An item is in one stage at a time: at most one stay is still open.
CREATE UNIQUE INDEX item_stage_history_open_idx ON app.item_stage_history (item_id)
  WHERE left_at IS NULL;

INSERT INTO app.item_stage_history (item_id, stage_id, stage_name, entered_at, moved_by)
SELECT i.id, i.stage_id, s.name, i.created_at, i.created_by
FROM app.items i JOIN app.list_stages s ON s.id = i.stage_id;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.list_stages
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('created_by');
CREATE TRIGGER touch BEFORE UPDATE ON app.list_stages
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE FUNCTION app.list_stages_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.list_id <> OLD.list_id THEN
      RAISE EXCEPTION 'a stage cannot move to another list' USING ERRCODE = 'CB003';
    END IF;
    RETURN NEW;
  END IF;
  -- Removals of stages of one list happen one at a time, so two people
  -- cannot each remove "the second to last" and leave the list with none.
  PERFORM 1 FROM app.lists l WHERE l.id = OLD.list_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM app.list_stages s WHERE s.list_id = OLD.list_id AND s.id <> OLD.id
  ) THEN
    RAISE EXCEPTION 'a list keeps at least one stage' USING ERRCODE = 'CB003';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.list_stages
  FOR EACH ROW EXECUTE FUNCTION app.list_stages_guard();

-- An item always has a stage of its own list, and only the database decides
-- since when.
CREATE FUNCTION app.items_stage_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.stage_id IS NULL THEN
      SELECT s.id INTO NEW.stage_id FROM app.list_stages s
      WHERE s.list_id = NEW.list_id ORDER BY s.position, s.created_at LIMIT 1;
    END IF;
    IF NEW.stage_id IS NULL THEN
      RAISE EXCEPTION 'the list has no stages' USING ERRCODE = 'CB003';
    END IF;
    NEW.stage_since := now();
    RETURN NEW;
  END IF;

  -- Moved to another list without choosing a stage there: it lands on the first.
  IF NEW.list_id <> OLD.list_id AND NEW.stage_id = OLD.stage_id THEN
    NEW.stage_id := NULL;
    SELECT s.id INTO NEW.stage_id FROM app.list_stages s
    WHERE s.list_id = NEW.list_id ORDER BY s.position, s.created_at LIMIT 1;
    IF NEW.stage_id IS NULL THEN
      RAISE EXCEPTION 'the list has no stages' USING ERRCODE = 'CB003';
    END IF;
  END IF;
  IF NEW.stage_id <> OLD.stage_id THEN
    NEW.stage_since := now();
  ELSE
    NEW.stage_since := OLD.stage_since;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stage_guard BEFORE INSERT OR UPDATE ON app.items
  FOR EACH ROW EXECUTE FUNCTION app.items_stage_guard();

-- The history is written here, by the database, so no endpoint can forget it
-- and nobody can rewrite how long something really took.
CREATE FUNCTION app.items_stage_track() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.stage_id = OLD.stage_id THEN
      RETURN NULL;
    END IF;
    UPDATE app.item_stage_history h SET left_at = now()
    WHERE h.item_id = NEW.id AND h.left_at IS NULL;
  END IF;
  INSERT INTO app.item_stage_history (item_id, stage_id, stage_name, entered_at, moved_by)
  SELECT NEW.id, s.id, s.name, now(), authz.uid()
  FROM app.list_stages s WHERE s.id = NEW.stage_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER stage_track AFTER INSERT OR UPDATE ON app.items
  FOR EACH ROW EXECUTE FUNCTION app.items_stage_track();

-- Whether any item at all is still in a stage, counting items the caller
-- cannot see. Answers only to whoever manages the stage's list.
CREATE FUNCTION app.stage_in_use(p_stage uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.items i
    JOIN app.list_stages s ON s.id = i.stage_id
    WHERE i.stage_id = p_stage AND authz.list_level(s.list_id) = 'manage'
  )
$$;

-- Changing the stages of a list changes how everyone's work is read: on the record.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.list_stages
  FOR EACH ROW EXECUTE FUNCTION audit.on_security_change('list_id');

-- ---------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------

ALTER TABLE app.list_stages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.item_stage_history ENABLE ROW LEVEL SECURITY;

-- Whoever can open a list sees its stages; only who manages the list changes them.
CREATE POLICY list_stages_select ON app.list_stages FOR SELECT TO cerebro_app
  USING (authz.list_level(list_id) >= 'view');
CREATE POLICY list_stages_insert ON app.list_stages FOR INSERT TO cerebro_app
  WITH CHECK (authz.list_level(list_id) = 'manage');
CREATE POLICY list_stages_update ON app.list_stages FOR UPDATE TO cerebro_app
  USING (authz.list_level(list_id) = 'manage')
  WITH CHECK (authz.list_level(list_id) = 'manage');
CREATE POLICY list_stages_delete ON app.list_stages FOR DELETE TO cerebro_app
  USING (authz.list_level(list_id) = 'manage');

-- The history of an item is visible exactly to whoever can see the item.
CREATE POLICY item_stage_history_select ON app.item_stage_history FOR SELECT TO cerebro_app
  USING (authz.item_level(item_id) >= 'view');

GRANT SELECT ON app.list_stages, app.item_stage_history TO cerebro_app;
GRANT INSERT (id, list_id, name, color, kind, position) ON app.list_stages TO cerebro_app;
GRANT UPDATE (name, color, kind, position) ON app.list_stages TO cerebro_app;
GRANT DELETE ON app.list_stages TO cerebro_app;
-- The stage can be chosen; "since when" cannot.
GRANT INSERT (stage_id), UPDATE (stage_id) ON app.items TO cerebro_app;

REVOKE EXECUTE ON FUNCTION app.list_stages_guard(), app.items_stage_guard(),
  app.items_stage_track(), app.stage_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.stage_in_use(uuid) TO cerebro_app;
