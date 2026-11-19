-- =============================================================================
-- Two lookups that answered about anything (D78).
--
--   1. Whether an item can hold subtasks was asked by naming the item and a
--      list, any item and any list. Now the question is asked about an item the
--      caller sees: does its own parent still hold subtasks? The old function
--      stays for the database's own routines.
--   2. The title of a form, shown in an item's history, goes only to whoever
--      sees the form's list, like the name of an automation.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The parent of an item the caller sees
-- ---------------------------------------------------------------------------

-- Null when the caller does not see the item or it has no parent.
CREATE FUNCTION app.parent_still_usable(p_item uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.parent_usable(i.parent_id, i.list_id)
  FROM app.items i
  WHERE i.id = p_item
    AND i.parent_id IS NOT NULL
    AND authz.item_level(i.id) >= 'view'
$$;

REVOKE EXECUTE ON FUNCTION app.parent_still_usable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.parent_still_usable(uuid) TO cerebro_app;
REVOKE EXECUTE ON FUNCTION app.parent_usable(uuid, uuid) FROM cerebro_app;

-- ---------------------------------------------------------------------------
-- 2. The title of a form
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.form_title(p_form uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT f.title FROM app.forms f
  WHERE f.id = p_form AND authz.list_level(f.list_id) >= 'view'
$$;
