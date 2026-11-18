-- =============================================================================
-- A field that names people: who sold, who checked, who to call. It can name
-- only people who can work in the item's list, the same rule as handing them
-- the item itself.
-- =============================================================================

ALTER TYPE app.field_kind ADD VALUE 'people';

-- The rules every other kind follows stay where they are; this adds the new
-- kind in front of them.
ALTER FUNCTION app.field_value_problem(app.field_kind, jsonb, jsonb, jsonb)
  RENAME TO field_value_problem_base;

CREATE FUNCTION app.field_value_problem(
  p_kind app.field_kind, p_config jsonb, p_value jsonb, p_previous jsonb
) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF p_kind::text = 'people' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'array' OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_value) AS e
      WHERE jsonb_typeof(e) <> 'string'
         OR (e #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) THEN
      RETURN 'expected a list of people';
    END IF;
    IF jsonb_array_length(p_value) = 0 THEN
      RETURN 'empty list';
    END IF;
    IF jsonb_array_length(p_value) > 20 THEN
      RETURN 'too many people';
    END IF;
    IF (SELECT count(DISTINCT e) FROM jsonb_array_elements_text(p_value) AS e)
       <> jsonb_array_length(p_value) THEN
      RETURN 'the same person twice';
    END IF;
    RETURN NULL;
  END IF;
  RETURN app.field_value_problem_base(p_kind, p_config, p_value, p_previous);
END
$$;

-- Anyone newly named must be able to work in the item's list. Someone already
-- named may stay, as an archived option may: the value was right when written.
CREATE FUNCTION app.item_field_values_people_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_list uuid;
BEGIN
  IF session_user <> 'cerebro_app' THEN
    RETURN NEW;
  END IF;
  SELECT i.list_id INTO v_list
  FROM app.items i JOIN app.list_fields f ON f.list_id = i.list_id
  WHERE i.id = NEW.item_id AND f.id = NEW.field_id AND f.kind::text = 'people';
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(NEW.value) AS p
    WHERE NOT (
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.value ELSE coalesce((
        SELECT v.value FROM app.item_field_values v
        WHERE v.item_id = NEW.item_id AND v.field_id = NEW.field_id
      ), '[]'::jsonb) END ? p
    )
    AND coalesce(authz.list_level_of(p::uuid, v_list), 'none') < 'edit'
  ) THEN
    RAISE EXCEPTION 'a person named here cannot work in this list' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER people_can_work BEFORE INSERT OR UPDATE ON app.item_field_values
  FOR EACH ROW EXECUTE FUNCTION app.item_field_values_people_guard();

-- Moving an item: people who cannot work in the other list stay behind with
-- the rest of what does not fit there.
CREATE OR REPLACE FUNCTION app.items_carry_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.list_id = OLD.list_id THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.item_field_values (item_id, field_id, value, updated_by)
  SELECT NEW.id, dest.id, v.value, coalesce(authz.uid(), v.updated_by)
  FROM app.item_field_values v
  JOIN app.list_fields src
    ON src.id = v.field_id AND src.list_id = OLD.list_id AND NOT src.is_archived
  JOIN app.list_fields dest
    ON dest.list_id = NEW.list_id AND dest.origin_id = src.origin_id
   AND dest.kind = src.kind AND NOT dest.is_archived
  WHERE v.item_id = NEW.id
    AND app.field_value_problem(dest.kind, dest.config, v.value, NULL) IS NULL
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
  app.field_value_problem(app.field_kind, jsonb, jsonb, jsonb),
  app.item_field_values_people_guard()
FROM PUBLIC;
