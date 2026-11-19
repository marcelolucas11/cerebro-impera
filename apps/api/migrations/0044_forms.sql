-- =============================================================================
-- Public forms (Fase 10): a page on an address of its own where anyone can
-- send something in, and it arrives as an item of a list. The page only
-- sends: the service behind it connects as `cerebro_forms`, which can read no
-- table and can only call the three functions at the end of this file.
--
-- A form is made and changed by whoever manages the list, with the code
-- confirmed again, and sends with that person's access, never more: the item
-- is created as theirs, marked as the form's in the item and in its history,
-- and stops arriving the moment they could no longer add it by hand.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerebro_forms') THEN
    CREATE ROLE cerebro_forms NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA app TO cerebro_forms;

-- ---------------------------------------------------------------------------
-- Which form is sending, kept where no service can write
-- ---------------------------------------------------------------------------

-- A form sends with no session behind it.
ALTER TABLE authz.request_ctx
  ALTER COLUMN session_id DROP NOT NULL,
  ADD COLUMN form_id uuid;

CREATE OR REPLACE FUNCTION authz.request_ctx_fresh() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.xact_start IS DISTINCT FROM OLD.xact_start THEN
    NEW.automation_id := NULL;
    NEW.automation_depth := 0;
    NEW.form_id := NULL;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION authz.form_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.form_id FROM authz.request_ctx c
  WHERE c.pid = pg_backend_pid() AND c.xact_start = transaction_timestamp()
$$;

-- ---------------------------------------------------------------------------
-- Forms
-- ---------------------------------------------------------------------------

CREATE TABLE app.forms (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id           uuid NOT NULL REFERENCES app.lists (id) ON DELETE CASCADE,
  -- The public address: 122 random bits, never derived from anything else.
  slug              text NOT NULL UNIQUE
                      DEFAULT rtrim(translate(encode(uuid_send(gen_random_uuid()), 'base64'),
                                              '+/', '-_'), '=')
                      CHECK (slug ~ '^[A-Za-z0-9_-]{22}$'),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120 AND title = btrim(title)),
  intro             text NOT NULL DEFAULT '' CHECK (char_length(intro) <= 2000),
  -- The question whose answer becomes the item's title, and the one (if any)
  -- whose answer becomes its description.
  title_label       text NOT NULL
                      CHECK (char_length(title_label) BETWEEN 1 AND 120 AND title_label = btrim(title_label)),
  description_label text CHECK (description_label IS NULL OR (
                      char_length(description_label) BETWEEN 1 AND 120
                      AND description_label = btrim(description_label))),
  -- The list's fields it asks for, in order: [{"id": ..., "required": ...}].
  fields            jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Where the item lands. No foreign key: a stage removed later sends items to the
  -- list's first stage, without touching the form (and who it acts as).
  stage_id          uuid,
  enabled           boolean NOT NULL DEFAULT true,
  -- Whoever saved it last: it sends with their access.
  run_as            uuid NOT NULL REFERENCES app.users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX forms_list_idx ON app.forms (list_id);

-- Only these kinds are asked of strangers: no people, no files, no secrets.
CREATE FUNCTION app.form_fields_problem(p_list uuid, p_fields jsonb) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_entry jsonb;
  v_ids   text[] := '{}';
BEGIN
  IF jsonb_typeof(p_fields) IS DISTINCT FROM 'array' THEN
    RETURN 'the fields of a form are a list';
  END IF;
  IF jsonb_array_length(p_fields) > 20 THEN
    RETURN 'a form asks at most 20 fields';
  END IF;
  FOR v_entry IN SELECT e FROM jsonb_array_elements(p_fields) AS e LOOP
    IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object'
       OR v_entry - 'id' - 'required' <> '{}'::jsonb
       OR jsonb_typeof(v_entry -> 'required') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(v_entry -> 'id') IS DISTINCT FROM 'string'
       OR (v_entry ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN 'each field of a form is an id and whether it is required';
    END IF;
    IF (v_entry ->> 'id') = ANY (v_ids) THEN
      RETURN 'a form asks each field once';
    END IF;
    v_ids := v_ids || (v_entry ->> 'id');
    IF NOT EXISTS (
      SELECT 1 FROM app.list_fields f
      WHERE f.id = (v_entry ->> 'id')::uuid AND f.list_id = p_list AND NOT f.is_archived
        AND f.kind IN ('text', 'long_text', 'number', 'money', 'date', 'select', 'checkbox',
                       'url', 'email', 'phone')
    ) THEN
      RETURN 'a form asks only fields of its list that strangers may fill in';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.forms_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_problem text;
  v_needed  app.user_role;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.list_id <> OLD.list_id OR NEW.slug <> OLD.slug OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'a form keeps its list and its address' USING ERRCODE = 'CB003';
    END IF;
    NEW.updated_at := now();
  ELSIF (SELECT count(*) FROM app.forms f WHERE f.list_id = NEW.list_id) >= 20 THEN
    RAISE EXCEPTION 'a list has at most 20 forms' USING ERRCODE = 'CB003';
  END IF;

  v_problem := app.form_fields_problem(NEW.list_id, NEW.fields);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = '23514';
  END IF;

  IF NEW.stage_id IS NOT NULL THEN
    SELECT s.entry_role INTO v_needed FROM app.list_stages s
    WHERE s.id = NEW.stage_id AND s.list_id = NEW.list_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the stage is not one of the list''s' USING ERRCODE = '23514';
    END IF;
    -- A form puts items only where whoever saves it could put them by hand.
    IF session_user = 'cerebro_app' AND v_needed IS NOT NULL
       AND NOT coalesce(authz.my_role() >= v_needed, false) THEN
      RAISE EXCEPTION 'only % and above put items in this stage', v_needed USING ERRCODE = 'CB004';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.forms
  FOR EACH ROW EXECUTE FUNCTION app.forms_guard();
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON app.forms
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('run_as', 'restamp');

-- A new door into a list: on the record, and owners are told when someone else opens one.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.forms
  FOR EACH ROW EXECUTE FUNCTION audit.on_security_change('list_id', 'alert');

-- What each form sent, for counting and for the daily limit. Nothing about who sent it.
CREATE TABLE app.form_submissions (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  form_id uuid NOT NULL REFERENCES app.forms (id) ON DELETE CASCADE,
  -- No foreign key: the record stays when the item goes.
  item_id uuid NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX form_submissions_form_idx ON app.form_submissions (form_id, at DESC);

-- The mark of the form on what it creates. No foreign keys: the mark stays when
-- the form is removed, and removing it changes no item.
ALTER TABLE app.items ADD COLUMN form_id uuid;
ALTER TABLE app.item_changes ADD COLUMN form_id uuid DEFAULT authz.form_id();

-- The name of a form, for the history: the title only (the page shows it to anyone).
CREATE FUNCTION app.form_title(p_form uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT f.title FROM app.forms f WHERE f.id = p_form
$$;

ALTER TABLE app.forms ENABLE ROW LEVEL SECURITY;
CREATE POLICY forms_select ON app.forms FOR SELECT TO cerebro_app
  USING (authz.list_level(list_id) >= 'manage');
CREATE POLICY forms_insert ON app.forms FOR INSERT TO cerebro_app
  WITH CHECK (authz.list_level(list_id) >= 'manage' AND authz.step_up_ok());
CREATE POLICY forms_update ON app.forms FOR UPDATE TO cerebro_app
  USING (authz.list_level(list_id) >= 'manage' AND authz.step_up_ok())
  WITH CHECK (authz.list_level(list_id) >= 'manage' AND authz.step_up_ok());
CREATE POLICY forms_delete ON app.forms FOR DELETE TO cerebro_app
  USING (authz.list_level(list_id) >= 'manage' AND authz.step_up_ok());
GRANT SELECT, DELETE ON app.forms TO cerebro_app;
GRANT INSERT (list_id, title, intro, title_label, description_label, fields, stage_id, enabled)
  ON app.forms TO cerebro_app;
GRANT UPDATE (title, intro, title_label, description_label, fields, stage_id, enabled)
  ON app.forms TO cerebro_app;

ALTER TABLE app.form_submissions ENABLE ROW LEVEL SECURITY;
-- Seen by whoever sees the form.
CREATE POLICY form_submissions_select ON app.form_submissions FOR SELECT TO cerebro_app
  USING (EXISTS (SELECT 1 FROM app.forms f WHERE f.id = form_id));
GRANT SELECT ON app.form_submissions TO cerebro_app;

-- ---------------------------------------------------------------------------
-- What the forms service may do: show a form, send it, show the brand
-- ---------------------------------------------------------------------------

-- The form as strangers see it, or null when it is not open: switched off, gone,
-- or its author could no longer add items to the list.
CREATE FUNCTION app.form_view(p_slug text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_form app.forms;
BEGIN
  -- Never from inside a signed-in request.
  IF authz.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  SELECT f.* INTO v_form FROM app.forms f WHERE f.slug = p_slug AND f.enabled;
  IF NOT FOUND OR coalesce(authz.list_level_of(v_form.run_as, v_form.list_id), 'none') < 'edit' THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'title', v_form.title,
    'intro', v_form.intro,
    'titleLabel', v_form.title_label,
    'descriptionLabel', v_form.description_label,
    'fields', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', lf.id,
               'name', lf.name,
               'kind', lf.kind,
               'required', (e.entry ->> 'required')::boolean,
               'currency', CASE WHEN lf.kind = 'money' THEN lf.config ->> 'currency' END,
               'options', CASE WHEN lf.kind = 'select' THEN (
                 SELECT coalesce(jsonb_agg(jsonb_build_object('id', o ->> 'id', 'name', o ->> 'name')),
                                 '[]'::jsonb)
                 FROM jsonb_array_elements(lf.config -> 'options') AS o
                 WHERE NOT coalesce((o ->> 'archived')::boolean, false)) END)
             ORDER BY e.n)
      FROM jsonb_array_elements(v_form.fields) WITH ORDINALITY AS e (entry, n)
      JOIN app.list_fields lf ON lf.id = (e.entry ->> 'id')::uuid AND NOT lf.is_archived
    ), '[]'::jsonb));
END
$$;

-- Sends one answer: 'sent', 'closed' (not open) or 'full' (its limit for the day).
-- The service checks every answer first; this checks again what holds the line.
CREATE FUNCTION app.form_submit(p_slug text, p_title text, p_description text, p_values jsonb)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_form  app.forms;
  v_item  uuid := gen_random_uuid();
  v_key   text;
  v_stage uuid;
BEGIN
  IF authz.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  SELECT f.* INTO v_form FROM app.forms f WHERE f.slug = p_slug AND f.enabled FOR UPDATE;
  IF NOT FOUND OR coalesce(authz.list_level_of(v_form.run_as, v_form.list_id), 'none') < 'edit' THEN
    RETURN 'closed';
  END IF;

  IF p_title IS NULL OR char_length(btrim(p_title)) NOT BETWEEN 1 AND 500
     OR (p_description IS NOT NULL
         AND (v_form.description_label IS NULL OR char_length(p_description) > 5000))
     OR jsonb_typeof(p_values) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'the answer does not fit the form' USING ERRCODE = '22023';
  END IF;
  -- Only what the form asks, and everything it requires.
  FOR v_key IN SELECT jsonb_object_keys(p_values) LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_form.fields) AS e WHERE e ->> 'id' = v_key) THEN
      RAISE EXCEPTION 'the answer does not fit the form' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_form.fields) AS e
    WHERE (e ->> 'required')::boolean AND NOT p_values ? (e ->> 'id')
  ) THEN
    RAISE EXCEPTION 'the answer does not fit the form' USING ERRCODE = '22023';
  END IF;

  -- However many people send, a list takes at most 500 a day from one form.
  IF (SELECT count(*) FROM app.form_submissions s
      WHERE s.form_id = v_form.id AND s.at > now() - interval '1 day') >= 500 THEN
    RETURN 'full';
  END IF;

  -- From here until the end, the acting person is the form's author, with no
  -- recent code, and what they do is marked as the form's.
  INSERT INTO authz.request_ctx AS c (pid, xact_start, user_id, session_id, ip, step_up)
  VALUES (pg_backend_pid(), transaction_timestamp(), v_form.run_as, NULL, NULL, false)
  ON CONFLICT (pid) DO UPDATE
    SET xact_start = EXCLUDED.xact_start, user_id = EXCLUDED.user_id,
        session_id = NULL, ip = NULL, step_up = false;
  UPDATE authz.request_ctx SET form_id = v_form.id WHERE pid = pg_backend_pid();

  SELECT s.id INTO v_stage FROM app.list_stages s
  WHERE s.id = v_form.stage_id AND s.list_id = v_form.list_id;
  INSERT INTO app.items (id, list_id, title, description, created_by, stage_id, form_id)
  VALUES (v_item, v_form.list_id, btrim(p_title), coalesce(btrim(p_description), ''),
          v_form.run_as, v_stage, v_form.id);
  FOR v_key IN SELECT jsonb_object_keys(p_values) LOOP
    INSERT INTO app.item_field_values (item_id, field_id, value, updated_by)
    VALUES (v_item, v_key::uuid, p_values -> v_key, v_form.run_as);
  END LOOP;
  INSERT INTO app.form_submissions (form_id, item_id) VALUES (v_form.id, v_item);
  RETURN 'sent';
END
$$;

-- The installation's name and color, for the form pages.
CREATE FUNCTION app.forms_brand() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('name', i.instance_name, 'color', i.brand_color)
  FROM app.instance_settings i
$$;

GRANT EXECUTE ON FUNCTION app.form_view(text), app.form_submit(text, text, text, jsonb),
  app.forms_brand() TO cerebro_forms;
GRANT EXECUTE ON FUNCTION app.form_title(uuid) TO cerebro_app;
