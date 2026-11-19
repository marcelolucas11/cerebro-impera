-- =============================================================================
-- What goes on the record, by who may say it (D86).
--
-- The record took any of its entries from anyone signed in, in their own name.
-- Now what an update did is said only by an owner (only owners see and run
-- updates), and "opened a sensitive list" only by someone who can open it.
-- =============================================================================

CREATE OR REPLACE FUNCTION audit.record(
  p_action text, p_target_type text DEFAULT NULL, p_target_id text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF authz.uid() IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  IF p_action IS NULL OR p_action NOT IN (
       'list.sensitive_viewed', 'item.assignees_changed', 'items.bulk_assigned',
       'items.bulk_trashed', 'attachment.downloaded', 'secret.revealed',
       'automations.created', 'automations.updated', 'automations.removed',
       'update.checked', 'update.requested', 'update.refused', 'update.applied',
       'update.rolled_back', 'update.failed')
     OR (p_target_type IS NOT NULL
         AND p_target_type NOT IN ('list', 'item', 'attachment', 'automation', 'update'))
     OR char_length(coalesce(p_target_id, '')) > 100
     OR octet_length(coalesce(p_metadata, '{}'::jsonb)::text) > 8192 THEN
    RAISE EXCEPTION 'not an entry for the record' USING ERRCODE = '22023';
  END IF;
  IF p_action LIKE 'update.%' AND NOT authz.is_owner() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  IF p_action = 'list.sensitive_viewed'
     AND (p_target_type IS DISTINCT FROM 'list'
          OR p_target_id IS NULL
          OR p_target_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR coalesce(authz.list_level(p_target_id::uuid), 'none') < 'view') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  RETURN audit.append_entry(authz.uid(), authz.session_id(), authz.client_ip(),
                            p_action, p_target_type, p_target_id, p_metadata);
END
$$;
