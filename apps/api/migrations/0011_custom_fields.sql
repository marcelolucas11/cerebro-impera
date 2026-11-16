-- =============================================================================
-- Custom fields. Each list decides what it records about its items beyond the
-- title: a supplier, a purchase date, a value, a status of its own. The rules
-- for what a value may be live here as well as in the API, so they hold for
-- every path that writes one.
-- =============================================================================

CREATE TYPE app.field_kind AS ENUM (
  'text', 'long_text', 'number', 'money', 'date', 'datetime',
  'select', 'labels', 'checkbox', 'url', 'email', 'phone', 'rating'
);

CREATE TABLE app.list_fields (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id     uuid NOT NULL REFERENCES app.lists (id),
  -- A copy of a field keeps the id of the first one, so totals across lists
  -- can tell "the same field" from two fields that merely share a name.
  origin_id   uuid NOT NULL,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60 AND name = btrim(name)),
  kind        app.field_kind NOT NULL,
  -- Options of a choice field, currency of a money field, scale of a rating.
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  position    integer NOT NULL DEFAULT 0,
  -- Fields are never deleted: an archived field disappears from the list and
  -- keeps every value, so bringing it back loses nothing.
  is_archived boolean NOT NULL DEFAULT false,
  created_by  uuid NOT NULL REFERENCES app.users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX list_fields_name_idx ON app.list_fields (list_id, lower(name))
  WHERE NOT is_archived;
-- A list has each "same field" at most once.
CREATE UNIQUE INDEX list_fields_origin_idx ON app.list_fields (list_id, origin_id)
  WHERE NOT is_archived;
CREATE INDEX list_fields_order_idx ON app.list_fields (list_id, position);

-- One row per item and field that has a value. No value, no row.
CREATE TABLE app.item_field_values (
  item_id    uuid NOT NULL REFERENCES app.items (id) ON DELETE CASCADE,
  field_id   uuid NOT NULL REFERENCES app.list_fields (id),
  value      jsonb NOT NULL,
  updated_by uuid NOT NULL REFERENCES app.users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, field_id)
);
CREATE INDEX item_field_values_field_idx ON app.item_field_values (field_id);

-- ---------------------------------------------------------------------------
-- What a configuration and a value may be
-- ---------------------------------------------------------------------------

-- NULL when the configuration fits the kind; otherwise what is wrong with it.
CREATE FUNCTION app.field_config_problem(p_kind app.field_kind, p_config jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_option jsonb;
  v_ids    text[] := '{}';
  v_names  text[] := '{}';
BEGIN
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object' THEN
    RETURN 'the settings of a field are an object';
  END IF;

  IF p_kind IN ('select', 'labels') THEN
    IF p_config - 'options' <> '{}'::jsonb
       OR jsonb_typeof(p_config -> 'options') IS DISTINCT FROM 'array' THEN
      RETURN 'a choice field has a list of options and nothing else';
    END IF;
    IF jsonb_array_length(p_config -> 'options') > 100 THEN
      RETURN 'too many options';
    END IF;
    FOR v_option IN SELECT o FROM jsonb_array_elements(p_config -> 'options') AS o LOOP
      IF jsonb_typeof(v_option) <> 'object'
         OR v_option - 'id' - 'name' - 'color' - 'archived' <> '{}'::jsonb
         OR jsonb_typeof(v_option -> 'id') IS DISTINCT FROM 'string'
         OR jsonb_typeof(v_option -> 'name') IS DISTINCT FROM 'string'
         OR jsonb_typeof(v_option -> 'color') IS DISTINCT FROM 'string'
         OR (v_option ? 'archived' AND jsonb_typeof(v_option -> 'archived') <> 'boolean') THEN
        RETURN 'invalid option';
      END IF;
      IF (v_option ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR length(v_option ->> 'name') NOT BETWEEN 1 AND 60
         OR (v_option ->> 'name') <> btrim(v_option ->> 'name')
         OR (v_option ->> 'color') !~ '^#[0-9a-f]{6}$' THEN
        RETURN 'invalid option';
      END IF;
      IF (v_option ->> 'id') = ANY (v_ids) THEN
        RETURN 'two options share an id';
      END IF;
      v_ids := v_ids || (v_option ->> 'id');
      IF NOT coalesce((v_option ->> 'archived')::boolean, false) THEN
        IF lower(v_option ->> 'name') = ANY (v_names) THEN
          RETURN 'two options share a name';
        END IF;
        v_names := v_names || lower(v_option ->> 'name');
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;

  IF p_kind = 'money' THEN
    IF p_config - 'currency' <> '{}'::jsonb
       OR jsonb_typeof(p_config -> 'currency') IS DISTINCT FROM 'string'
       OR (p_config ->> 'currency') !~ '^[A-Z]{3}$' THEN
      RETURN 'a money field has a three-letter currency and nothing else';
    END IF;
    RETURN NULL;
  END IF;

  IF p_kind = 'rating' THEN
    IF p_config - 'max' <> '{}'::jsonb
       OR jsonb_typeof(p_config -> 'max') IS DISTINCT FROM 'number'
       OR (p_config ->> 'max') !~ '^[0-9]{1,2}$'
       OR (p_config ->> 'max')::integer NOT BETWEEN 3 AND 10 THEN
      RETURN 'a rating goes up to a whole number from 3 to 10';
    END IF;
    RETURN NULL;
  END IF;

  IF p_config <> '{}'::jsonb THEN
    RETURN 'this kind of field has no settings';
  END IF;
  RETURN NULL;
END
$$;

-- NULL when the value can be stored in a field of this kind; otherwise what is
-- wrong with it. `p_previous` is the value being replaced: an option archived
-- since it was chosen may stay, and cannot be newly chosen.
CREATE FUNCTION app.field_value_problem(
  p_kind app.field_kind, p_config jsonb, p_value jsonb, p_previous jsonb
) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_type    text := jsonb_typeof(p_value);
  v_text    text;
  v_number  numeric;
  v_kept    text[] := '{}';
  v_allowed text[];
  v_chosen  text[];
BEGIN
  IF p_kind IN ('text', 'long_text', 'url', 'email', 'phone') THEN
    IF v_type <> 'string' THEN
      RETURN 'expected text';
    END IF;
    v_text := p_value #>> '{}';
    IF v_text !~ '[^[:space:]]' THEN
      RETURN 'empty text';
    END IF;
    -- In parentheses: PL/pgSQL would otherwise end the condition at the CASE's own THEN.
    IF length(v_text) > (CASE p_kind
         WHEN 'text' THEN 500 WHEN 'long_text' THEN 20000
         WHEN 'url' THEN 2000 WHEN 'email' THEN 320 ELSE 40 END) THEN
      RETURN 'text too long';
    END IF;
    IF p_kind = 'url' AND v_text !~ '^https?://[^[:space:]]+$' THEN
      RETURN 'not a web address';
    END IF;
    IF p_kind = 'email' AND v_text !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
      RETURN 'not an e-mail address';
    END IF;
    IF p_kind = 'phone' AND v_text !~ '^[0-9+() .-]{3,40}$' THEN
      RETURN 'not a phone number';
    END IF;
    RETURN NULL;
  END IF;

  IF p_kind IN ('number', 'money', 'rating') THEN
    IF v_type <> 'number' THEN
      RETURN 'expected a number';
    END IF;
    v_number := (p_value #>> '{}')::numeric;
    IF p_kind <> 'number' AND v_number <> trunc(v_number) THEN
      RETURN 'expected a whole number';
    END IF;
    IF p_kind = 'rating' THEN
      IF v_number NOT BETWEEN 1 AND (p_config ->> 'max')::numeric THEN
        RETURN 'rating out of range';
      END IF;
    ELSIF abs(v_number) > 1e15 THEN
      RETURN 'number out of range';
    END IF;
    RETURN NULL;
  END IF;

  IF p_kind = 'checkbox' THEN
    IF v_type <> 'boolean' THEN
      RETURN 'expected yes or no';
    END IF;
    RETURN NULL;
  END IF;

  IF p_kind IN ('date', 'datetime') THEN
    IF v_type <> 'string' THEN
      RETURN 'expected a date';
    END IF;
    v_text := p_value #>> '{}';
    IF p_kind = 'date' AND v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RETURN 'not a date';
    END IF;
    IF p_kind = 'datetime'
       AND v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$' THEN
      RETURN 'not a date and time';
    END IF;
    IF left(v_text, 4)::integer NOT BETWEEN 1900 AND 2200 THEN
      RETURN 'date out of range';
    END IF;
    BEGIN
      IF p_kind = 'date' THEN
        PERFORM v_text::date;
      ELSE
        PERFORM v_text::timestamptz;
      END IF;
    EXCEPTION WHEN data_exception THEN
      RETURN 'not a real date';
    END;
    RETURN NULL;
  END IF;

  -- Choice fields: the options that can be chosen now, plus the ones this
  -- item already had.
  IF jsonb_typeof(p_previous) = 'string' THEN
    v_kept := ARRAY[p_previous #>> '{}'];
  ELSIF jsonb_typeof(p_previous) = 'array' THEN
    SELECT coalesce(array_agg(e), '{}') INTO v_kept FROM jsonb_array_elements_text(p_previous) AS e;
  END IF;
  SELECT coalesce(array_agg(o ->> 'id'), '{}') INTO v_allowed
  FROM jsonb_array_elements(p_config -> 'options') AS o
  WHERE NOT coalesce((o ->> 'archived')::boolean, false) OR (o ->> 'id') = ANY (v_kept);

  IF p_kind = 'select' THEN
    IF v_type <> 'string' THEN
      RETURN 'expected one option';
    END IF;
    IF NOT (p_value #>> '{}') = ANY (v_allowed) THEN
      RETURN 'not an option of this field';
    END IF;
    RETURN NULL;
  END IF;

  IF v_type <> 'array' THEN
    RETURN 'expected a list of options';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_value) AS e WHERE jsonb_typeof(e) <> 'string') THEN
    RETURN 'expected a list of options';
  END IF;
  SELECT coalesce(array_agg(e), '{}') INTO v_chosen FROM jsonb_array_elements_text(p_value) AS e;
  IF cardinality(v_chosen) = 0 THEN
    RETURN 'empty list';
  END IF;
  IF cardinality(v_chosen) > 50 THEN
    RETURN 'too many options chosen';
  END IF;
  IF (SELECT count(DISTINCT c) FROM unnest(v_chosen) AS c) <> cardinality(v_chosen) THEN
    RETURN 'the same option twice';
  END IF;
  IF NOT v_chosen <@ v_allowed THEN
    RETURN 'not an option of this field';
  END IF;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.list_fields
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('created_by');
CREATE TRIGGER touch BEFORE UPDATE ON app.list_fields
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE FUNCTION app.list_fields_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_problem text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.origin_id IS NULL THEN
      NEW.origin_id := NEW.id;
    END IF;
    -- A copy may only claim to be "the same field" as one of the same kind
    -- that the person can actually see.
    IF NEW.origin_id <> NEW.id AND session_user = 'cerebro_app' AND NOT EXISTS (
      SELECT 1 FROM app.list_fields s
      WHERE s.origin_id = NEW.origin_id
        AND s.kind = NEW.kind
        AND authz.list_level(s.list_id) >= 'view'
    ) THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
    END IF;
  ELSE
    IF NEW.list_id <> OLD.list_id OR NEW.kind <> OLD.kind OR NEW.origin_id <> OLD.origin_id THEN
      RAISE EXCEPTION 'a field keeps its list, its kind and its origin' USING ERRCODE = 'CB003';
    END IF;
    -- Options are archived, never removed, so the items that have them keep
    -- reading right.
    IF NEW.kind IN ('select', 'labels') AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(OLD.config -> 'options') AS o
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.config -> 'options') AS n
        WHERE n ->> 'id' = o ->> 'id'
      )
    ) THEN
      RAISE EXCEPTION 'options are archived, not removed' USING ERRCODE = 'CB003';
    END IF;
    IF NEW.kind = 'rating' AND NEW.config <> OLD.config THEN
      RAISE EXCEPTION 'the scale of a rating does not change' USING ERRCODE = 'CB003';
    END IF;
  END IF;

  v_problem := app.field_config_problem(NEW.kind, NEW.config);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = '23514';
  END IF;

  IF NOT NEW.is_archived AND (TG_OP = 'INSERT' OR OLD.is_archived) AND (
    SELECT count(*) FROM app.list_fields f
    WHERE f.list_id = NEW.list_id AND NOT f.is_archived AND f.id <> NEW.id
  ) >= 60 THEN
    RAISE EXCEPTION 'a list has at most 60 fields' USING ERRCODE = 'CB003';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER keep BEFORE INSERT OR UPDATE ON app.list_fields
  FOR EACH ROW EXECUTE FUNCTION app.list_fields_guard();

-- Changing what a list records changes how everyone's work is read: on the record.
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON app.list_fields
  FOR EACH ROW EXECUTE FUNCTION audit.on_security_change('list_id');

CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.item_field_values
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('updated_by', 'restamp');

-- A value belongs to a field of the item's own list and fits the field's kind.
CREATE FUNCTION app.item_field_values_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_kind     app.field_kind;
  v_config   jsonb;
  v_previous jsonb;
  v_problem  text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.item_id <> OLD.item_id OR NEW.field_id <> OLD.field_id THEN
      RAISE EXCEPTION 'a value stays with its item and its field' USING ERRCODE = 'CB003';
    END IF;
    v_previous := OLD.value;
  ELSE
    -- An insert that turns into an update on conflict passes here first: what
    -- the item already has still counts as what it had.
    SELECT v.value INTO v_previous FROM app.item_field_values v
    WHERE v.item_id = NEW.item_id AND v.field_id = NEW.field_id;
  END IF;
  SELECT f.kind, f.config INTO v_kind, v_config
  FROM app.list_fields f
  JOIN app.items i ON i.list_id = f.list_id
  WHERE f.id = NEW.field_id AND i.id = NEW.item_id AND NOT f.is_archived;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the field is not one of the item''s list' USING ERRCODE = '23514';
  END IF;
  v_problem := app.field_value_problem(v_kind, v_config, NEW.value, v_previous);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER keep BEFORE INSERT OR UPDATE ON app.item_field_values
  FOR EACH ROW EXECUTE FUNCTION app.item_field_values_guard();

-- ---------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------

-- What the caller may do with one value: exactly what they may do with its
-- item, and nothing at all when the field is archived or belongs to a list the
-- item is no longer in.
CREATE FUNCTION authz.field_value_level(p_item uuid, p_field uuid) RETURNS app.access_level
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM app.items i
    JOIN app.list_fields f ON f.list_id = i.list_id
    WHERE i.id = p_item AND f.id = p_field AND NOT f.is_archived
  ) THEN authz.item_level(p_item) ELSE 'none'::app.access_level END
$$;

ALTER TABLE app.list_fields       ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.item_field_values ENABLE ROW LEVEL SECURITY;

-- Whoever can open a list sees which fields it has; only who manages the list
-- changes them.
CREATE POLICY list_fields_select ON app.list_fields FOR SELECT TO cerebro_app
  USING (list_id IN (
    SELECT a.list_id FROM authz.my_list_access() a WHERE a.level >= 'view'
  ));
CREATE POLICY list_fields_insert ON app.list_fields FOR INSERT TO cerebro_app
  WITH CHECK (authz.list_level(list_id) = 'manage');
CREATE POLICY list_fields_update ON app.list_fields FOR UPDATE TO cerebro_app
  USING (authz.list_level(list_id) = 'manage')
  WITH CHECK (authz.list_level(list_id) = 'manage');

-- Values follow the item: seen by who sees it, changed by who may edit it.
-- Reading asks for the item and the field themselves, so their own policies
-- decide, once per statement. A value whose field is archived, or belongs to a
-- list the item is no longer in, is not found.
CREATE POLICY item_field_values_select ON app.item_field_values FOR SELECT TO cerebro_app
  USING (EXISTS (
    SELECT 1 FROM app.items i
    JOIN app.list_fields f ON f.list_id = i.list_id
    WHERE i.id = item_field_values.item_id
      AND f.id = item_field_values.field_id
      AND NOT f.is_archived
  ));
CREATE POLICY item_field_values_insert ON app.item_field_values FOR INSERT TO cerebro_app
  WITH CHECK (authz.field_value_level(item_id, field_id) >= 'edit');
CREATE POLICY item_field_values_update ON app.item_field_values FOR UPDATE TO cerebro_app
  USING (authz.field_value_level(item_id, field_id) >= 'edit')
  WITH CHECK (authz.field_value_level(item_id, field_id) >= 'edit');
CREATE POLICY item_field_values_delete ON app.item_field_values FOR DELETE TO cerebro_app
  USING (authz.field_value_level(item_id, field_id) >= 'edit');

GRANT SELECT ON app.list_fields, app.item_field_values TO cerebro_app;
GRANT INSERT (id, list_id, origin_id, name, kind, config, position) ON app.list_fields TO cerebro_app;
-- No DELETE: a field is archived, and its kind and list never change.
GRANT UPDATE (name, config, position, is_archived) ON app.list_fields TO cerebro_app;
GRANT INSERT (item_id, field_id, value), UPDATE (value), DELETE ON app.item_field_values
  TO cerebro_app;

REVOKE EXECUTE ON FUNCTION
  app.field_config_problem(app.field_kind, jsonb),
  app.field_value_problem(app.field_kind, jsonb, jsonb, jsonb),
  app.list_fields_guard(),
  app.item_field_values_guard(),
  authz.field_value_level(uuid, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.field_value_level(uuid, uuid) TO cerebro_app;
