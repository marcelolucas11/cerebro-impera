-- =============================================================================
-- Alerts about the copies (Fase 9). The hourly routine reads how the backup
-- service is doing and, when a copy failed, there has been no good copy for
-- over a day, or the monthly restore test failed, warns the owners: once a
-- day per kind, so a problem that lasts does not bury every other alert. Only
-- the routine raises these, never a person's request, and only these kinds.
-- =============================================================================

CREATE FUNCTION app.raise_backup_alert(p_kind text, p_metadata jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF authz.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'backup alerts are raised by the routine, not in a request' USING ERRCODE = 'CB001';
  END IF;
  IF p_kind NOT IN ('backup_failed', 'backup_stale', 'restore_test_failed') THEN
    RAISE EXCEPTION 'not a backup alert' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM app.security_alerts a
             WHERE a.kind = p_kind AND a.at > now() - interval '24 hours') THEN
    RETURN false;
  END IF;
  PERFORM app.raise_alert(p_kind, 'critical', NULL, coalesce(p_metadata, '{}'::jsonb));
  RETURN true;
END
$$;

REVOKE EXECUTE ON FUNCTION app.raise_backup_alert(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.raise_backup_alert(text, jsonb) TO cerebro_app;
