-- =============================================================================
-- Someone who only sees their own items is, by definition, working on what
-- they create: such an item is assigned to its creator at birth.
--
-- Without this, an employee's new item would show "nobody responsible" to
-- the people who see the whole list, and the employee could not fix that,
-- since delegating work is reserved for those who see every item.
-- =============================================================================

CREATE FUNCTION app.items_self_assign() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := authz.uid();
BEGIN
  IF v_actor IS NULL OR NEW.created_by <> v_actor THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM authz.my_list_access() a
    WHERE a.list_id = NEW.list_id AND a.level >= 'edit' AND a.item_scope = 'assigned'
  ) THEN
    INSERT INTO app.item_assignees (item_id, user_id, assigned_by)
    VALUES (NEW.id, v_actor, v_actor)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER self_assign AFTER INSERT ON app.items
  FOR EACH ROW EXECUTE FUNCTION app.items_self_assign();

REVOKE EXECUTE ON FUNCTION app.items_self_assign() FROM PUBLIC;
