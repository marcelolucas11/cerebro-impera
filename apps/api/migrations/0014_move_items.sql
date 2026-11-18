-- =============================================================================
-- Moving an item to another list takes along what both lists record the same
-- way. A value goes with the item when the destination has the same field
-- (a copy with the same origin, of the same kind) and the value means the same
-- there: an option that exists there, money in the same currency. Anything
-- else stays behind, unseen, and comes back if the item does.
-- =============================================================================

CREATE FUNCTION app.items_carry_fields() RETURNS trigger
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
  ON CONFLICT (item_id, field_id) DO UPDATE SET value = EXCLUDED.value;
  RETURN NULL;
END
$$;
CREATE TRIGGER carry_fields AFTER UPDATE OF list_id ON app.items
  FOR EACH ROW EXECUTE FUNCTION app.items_carry_fields();

REVOKE EXECUTE ON FUNCTION app.items_carry_fields() FROM PUBLIC;
