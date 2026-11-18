-- =============================================================================
-- Sending several items to the trash at once is a critical action: it needs
-- the "bulk delete" capability (owners hold every capability) and a recent
-- second factor, it is on the record, and the owners are told. Counted per
-- transaction, so splitting the work into one statement per item inside a
-- request does not get around it.
-- =============================================================================

CREATE FUNCTION app.items_bulk_trash_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_now   integer;
  v_total integer;
BEGIN
  IF session_user <> 'cerebro_app' THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO v_now
  FROM new_rows n JOIN old_rows o ON o.id = n.id
  WHERE o.deleted_at IS NULL AND n.deleted_at IS NOT NULL;
  IF v_now = 0 THEN
    RETURN NULL;
  END IF;
  v_total := coalesce(nullif(current_setting('cerebro.trashed_in_request', true), '')::integer, 0)
             + v_now;
  PERFORM set_config('cerebro.trashed_in_request', v_total::text, true);
  IF v_total > 1 THEN
    IF NOT authz.has_capability('bulk_delete') THEN
      RAISE EXCEPTION 'sending several items to the trash needs the bulk delete capability'
        USING ERRCODE = 'CB001';
    END IF;
    PERFORM authz.require_step_up();
    PERFORM audit.record('items.bulk_trashed', NULL, NULL, jsonb_build_object('count', v_now));
    -- Once per request is enough for the owners to hear about it.
    IF v_total = v_now OR v_total - v_now <= 1 THEN
      PERFORM app.raise_alert('bulk_delete', 'warning', authz.uid(),
                              jsonb_build_object('count', v_total));
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER bulk_trash AFTER UPDATE ON app.items
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.items_bulk_trash_guard();

REVOKE EXECUTE ON FUNCTION app.items_bulk_trash_guard() FROM PUBLIC;
