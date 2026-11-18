-- =============================================================================
-- Live updates. When something changes, the database announces only which
-- list and item changed, and whose the item is (its creator and the people it
-- is with), on the channel "cerebro_live". No title, no value, no text ever
-- goes out. The server passes each announcement only to people who can open
-- that list, and, where someone sees only their own items, only when the item
-- is theirs; the page then asks again through the usual rules.
--
-- Also announced: someone's notifications changed ({"u": id}), and someone's
-- access changed ({"g": id}), so their open pages can catch up.
-- Identical announcements within one transaction are sent once.
-- =============================================================================

-- Whose an item is: its creator and the people it is with, plus anyone named.
CREATE FUNCTION app.live_item(p_item uuid, p_list uuid, p_also uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_people jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(DISTINCT person ORDER BY person), '[]'::jsonb) INTO v_people
  FROM (
    SELECT i.created_by AS person FROM app.items i WHERE i.id = p_item
    UNION
    SELECT ia.user_id FROM app.item_assignees ia WHERE ia.item_id = p_item
    UNION
    SELECT p_also WHERE p_also IS NOT NULL
  ) everyone;
  PERFORM pg_notify('cerebro_live',
                    jsonb_build_object('l', p_list, 'i', p_item, 'p', v_people)::text);
END
$$;

CREATE FUNCTION app.live_items() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM app.live_item(OLD.id, OLD.list_id);
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.list_id <> OLD.list_id) THEN
    PERFORM app.live_item(NEW.id, NEW.list_id);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER live AFTER INSERT OR UPDATE OR DELETE ON app.items
  FOR EACH ROW EXECUTE FUNCTION app.live_items();

-- Changes hanging from an item: announced for the item. Whoever was handed the
-- item, or taken off it, hears of it too.
CREATE FUNCTION app.live_item_part() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_item uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.item_id ELSE NEW.item_id END;
  v_list uuid;
  v_also uuid;
BEGIN
  SELECT i.list_id INTO v_list FROM app.items i WHERE i.id = v_item;
  IF v_list IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'item_assignees' THEN
    v_also := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  END IF;
  PERFORM app.live_item(v_item, v_list, v_also);
  RETURN NULL;
END
$$;
CREATE TRIGGER live AFTER INSERT OR DELETE ON app.item_assignees
  FOR EACH ROW EXECUTE FUNCTION app.live_item_part();
CREATE TRIGGER live AFTER INSERT OR UPDATE OR DELETE ON app.item_field_values
  FOR EACH ROW EXECUTE FUNCTION app.live_item_part();
CREATE TRIGGER live AFTER INSERT OR UPDATE OR DELETE ON app.item_checks
  FOR EACH ROW EXECUTE FUNCTION app.live_item_part();
CREATE TRIGGER live AFTER INSERT OR UPDATE ON app.item_comments
  FOR EACH ROW EXECUTE FUNCTION app.live_item_part();
CREATE TRIGGER live AFTER INSERT OR UPDATE OR DELETE ON app.item_secrets
  FOR EACH ROW EXECUTE FUNCTION app.live_item_part();
CREATE TRIGGER live AFTER INSERT OR UPDATE OR DELETE ON app.item_recurrences
  FOR EACH ROW EXECUTE FUNCTION app.live_item_part();
CREATE TRIGGER live AFTER INSERT OR UPDATE ON app.attachments
  FOR EACH ROW EXECUTE FUNCTION app.live_item_part();

-- Changes to a list itself, which everyone who opens it sees.
CREATE FUNCTION app.live_list() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_notify('cerebro_live', jsonb_build_object(
    'l', CASE WHEN TG_OP = 'DELETE' THEN OLD.list_id ELSE NEW.list_id END)::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER live AFTER INSERT OR UPDATE OR DELETE ON app.list_stages
  FOR EACH ROW EXECUTE FUNCTION app.live_list();
CREATE TRIGGER live AFTER INSERT OR UPDATE ON app.list_fields
  FOR EACH ROW EXECUTE FUNCTION app.live_list();

CREATE FUNCTION app.live_person() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row  jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  v_key  text := CASE TG_TABLE_NAME WHEN 'notifications' THEN 'u' ELSE 'g' END;
  v_user text;
BEGIN
  -- People are named by "id" in their own table and by "user_id" everywhere else.
  v_user := CASE TG_TABLE_NAME WHEN 'users' THEN v_row ->> 'id' ELSE v_row ->> 'user_id' END;
  PERFORM pg_notify('cerebro_live', jsonb_build_object(v_key, v_user)::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER live AFTER INSERT OR UPDATE ON app.notifications
  FOR EACH ROW EXECUTE FUNCTION app.live_person();
CREATE TRIGGER live AFTER INSERT OR UPDATE OR DELETE ON app.access_grants
  FOR EACH ROW EXECUTE FUNCTION app.live_person();
CREATE TRIGGER live AFTER UPDATE OF role, status ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.live_person();

REVOKE EXECUTE ON FUNCTION
  app.live_item(uuid, uuid, uuid),
  app.live_items(),
  app.live_item_part(),
  app.live_list(),
  app.live_person()
FROM PUBLIC;
