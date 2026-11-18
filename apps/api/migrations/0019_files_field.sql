-- =============================================================================
-- A field that points to files of the item: "signed contract", "invoice".
-- The files themselves are the item's attachments, with every rule they have;
-- the field only says which of them is which. It can name only attachments of
-- the same item that have finished arriving and are not in the trash.
-- =============================================================================

ALTER TYPE app.field_kind ADD VALUE 'files';

ALTER FUNCTION app.field_value_problem(app.field_kind, jsonb, jsonb, jsonb)
  RENAME TO field_value_problem_before_files;

CREATE FUNCTION app.field_value_problem(
  p_kind app.field_kind, p_config jsonb, p_value jsonb, p_previous jsonb
) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF p_kind::text = 'files' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'array' OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_value) AS e
      WHERE jsonb_typeof(e) <> 'string'
         OR (e #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) THEN
      RETURN 'expected a list of files';
    END IF;
    IF jsonb_array_length(p_value) = 0 THEN
      RETURN 'empty list';
    END IF;
    IF jsonb_array_length(p_value) > 20 THEN
      RETURN 'too many files';
    END IF;
    IF (SELECT count(DISTINCT e) FROM jsonb_array_elements_text(p_value) AS e)
       <> jsonb_array_length(p_value) THEN
      RETURN 'the same file twice';
    END IF;
    RETURN NULL;
  END IF;
  RETURN app.field_value_problem_before_files(p_kind, p_config, p_value, p_previous);
END
$$;

-- What of a list of files is still an attachment of the item that can be
-- named: finished arriving and not in the trash. In the order given.
CREATE FUNCTION app.files_still_attached(p_item uuid, p_value jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(t.id ORDER BY t.n), '[]'::jsonb)
  FROM jsonb_array_elements_text(p_value) WITH ORDINALITY AS t(id, n)
  WHERE EXISTS (
    SELECT 1 FROM app.attachments a
    WHERE a.id::text = t.id AND a.item_id = p_item
      AND a.status <> 'uploading' AND a.deleted_at IS NULL
  )
$$;

-- Anything newly named must be one of the item's own attachments. What was
-- already there may stay, as an archived option may: it was right when chosen.
CREATE FUNCTION app.item_field_values_files_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_previous jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.list_fields f WHERE f.id = NEW.field_id AND f.kind::text = 'files'
  ) OR app.field_value_problem('files', '{}'::jsonb, NEW.value, NULL) IS NOT NULL THEN
    -- Not a files field, or not a list of files: the other rules answer for it.
    RETURN NEW;
  END IF;
  v_previous := CASE WHEN TG_OP = 'UPDATE' THEN OLD.value ELSE coalesce((
    SELECT v.value FROM app.item_field_values v
    WHERE v.item_id = NEW.item_id AND v.field_id = NEW.field_id
  ), '[]'::jsonb) END;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(NEW.value) AS f
    WHERE NOT (v_previous ? f)
      AND NOT (app.files_still_attached(NEW.item_id, jsonb_build_array(f)) ? f)
  ) THEN
    RAISE EXCEPTION 'a file named here is not an attachment of the item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER files_of_the_item BEFORE INSERT OR UPDATE ON app.item_field_values
  FOR EACH ROW EXECUTE FUNCTION app.item_field_values_files_guard();

-- Moving an item: its attachments go with it, so a files field keeps what is
-- still attached; a value with nothing left stays behind with the rest.
CREATE OR REPLACE FUNCTION app.items_carry_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.list_id = OLD.list_id THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.item_field_values (item_id, field_id, value, updated_by)
  SELECT NEW.id, dest.id, c.value, coalesce(authz.uid(), v.updated_by)
  FROM app.item_field_values v
  JOIN app.list_fields src
    ON src.id = v.field_id AND src.list_id = OLD.list_id AND NOT src.is_archived
  JOIN app.list_fields dest
    ON dest.list_id = NEW.list_id AND dest.origin_id = src.origin_id
   AND dest.kind = src.kind AND NOT dest.is_archived
  CROSS JOIN LATERAL (
    SELECT CASE WHEN dest.kind::text = 'files'
                THEN app.files_still_attached(NEW.id, v.value)
                ELSE v.value END AS value
  ) c
  WHERE v.item_id = NEW.id
    AND app.field_value_problem(dest.kind, dest.config, c.value, NULL) IS NULL
    AND (dest.kind <> 'money' OR dest.config ->> 'currency' = src.config ->> 'currency')
    AND (dest.kind::text <> 'people' OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v.value) AS p
      WHERE coalesce(authz.list_level_of(p::uuid, NEW.list_id), 'none') < 'edit'
    ))
  ON CONFLICT (item_id, field_id) DO UPDATE SET value = EXCLUDED.value;
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION
  app.field_value_problem_before_files(app.field_kind, jsonb, jsonb, jsonb),
  app.field_value_problem(app.field_kind, jsonb, jsonb, jsonb),
  app.files_still_attached(uuid, jsonb),
  app.item_field_values_files_guard()
FROM PUBLIC;
