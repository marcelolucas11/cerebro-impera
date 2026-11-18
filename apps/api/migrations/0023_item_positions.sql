-- =============================================================================
-- Manual order on the board: a position per item, shared by everyone who sees
-- the column. Reordering is not a change to the item itself: it leaves "last
-- changed" and the history alone. An item that changes stage or list without
-- being placed goes to the end of its new column.
-- =============================================================================

ALTER TABLE app.items ADD COLUMN position double precision
  CHECK (position IS NULL OR (position = position AND abs(position) < 1e15));
CREATE INDEX items_order_idx ON app.items (list_id, stage_id, position);

CREATE FUNCTION app.items_touch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (NEW.stage_id <> OLD.stage_id OR NEW.list_id <> OLD.list_id)
     AND NEW.position IS NOT DISTINCT FROM OLD.position THEN
    NEW.position := NULL;
  END IF;
  IF (to_jsonb(NEW) - 'position' - 'updated_at') = (to_jsonb(OLD) - 'position' - 'updated_at') THEN
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER touch ON app.items;
CREATE TRIGGER touch BEFORE UPDATE ON app.items
  FOR EACH ROW EXECUTE FUNCTION app.items_touch();

GRANT UPDATE (position) ON app.items TO cerebro_app;

REVOKE EXECUTE ON FUNCTION app.items_touch() FROM PUBLIC;
