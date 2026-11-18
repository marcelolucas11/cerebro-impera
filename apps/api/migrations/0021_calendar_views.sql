-- =============================================================================
-- A third way of looking at a list: the calendar. Saved views may now keep it.
-- =============================================================================

ALTER TABLE app.saved_views DROP CONSTRAINT saved_views_kind_check;
ALTER TABLE app.saved_views ADD CONSTRAINT saved_views_kind_check
  CHECK (kind IN ('list', 'board', 'calendar'));
