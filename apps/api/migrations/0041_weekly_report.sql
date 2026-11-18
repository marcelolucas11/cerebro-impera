-- =============================================================================
-- The weekly report (Fase 6). Once a week the routine writes down, for every
-- list, what came in, what was finished, what is still open and what is late;
-- and the same per person on those lists. Owners read it; anyone else only with
-- the capability an owner hands out ("reports.view"), and then only the lists
-- where they see every item (a sensitive one after the code). Nobody writes,
-- changes or removes a report but the routine.
-- =============================================================================

ALTER TABLE app.user_capabilities DROP CONSTRAINT user_capabilities_capability_check;
ALTER TABLE app.user_capabilities ADD CONSTRAINT user_capabilities_capability_check
  CHECK (capability IN (
    'users.manage', 'devices.approve', 'audit.view', 'export', 'bulk_delete',
    'automations.manage', 'secret_fields.reveal', 'system.config', 'reports.view'
  ));

CREATE TABLE app.weekly_reports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Monday to Sunday, in the installation's calendar.
  week_start date NOT NULL UNIQUE CHECK (extract(isodow FROM week_start) = 1),
  made_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.weekly_report_lists (
  report_id uuid NOT NULL REFERENCES app.weekly_reports (id) ON DELETE CASCADE,
  list_id   uuid NOT NULL REFERENCES app.lists (id) ON DELETE CASCADE,
  created   integer NOT NULL CHECK (created >= 0),
  finished  integer NOT NULL CHECK (finished >= 0),
  open      integer NOT NULL CHECK (open >= 0),
  overdue   integer NOT NULL CHECK (overdue BETWEEN 0 AND open),
  PRIMARY KEY (report_id, list_id)
);

CREATE TABLE app.weekly_report_people (
  report_id uuid NOT NULL,
  list_id   uuid NOT NULL,
  user_id   uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  finished  integer NOT NULL CHECK (finished >= 0),
  open      integer NOT NULL CHECK (open >= 0),
  overdue   integer NOT NULL CHECK (overdue BETWEEN 0 AND open),
  PRIMARY KEY (report_id, list_id, user_id),
  FOREIGN KEY (report_id, list_id)
    REFERENCES app.weekly_report_lists (report_id, list_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Read: with the capability, and only the lists where the person sees every item
-- ---------------------------------------------------------------------------

ALTER TABLE app.weekly_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.weekly_report_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.weekly_report_people ENABLE ROW LEVEL SECURITY;

CREATE POLICY weekly_reports_select ON app.weekly_reports FOR SELECT TO cerebro_app
  USING ((SELECT authz.has_capability('reports.view')));
CREATE POLICY weekly_report_lists_select ON app.weekly_report_lists FOR SELECT TO cerebro_app
  USING ((SELECT authz.has_capability('reports.view'))
         AND list_id IN (SELECT authz.my_item_lists('view', true)));
CREATE POLICY weekly_report_people_select ON app.weekly_report_people FOR SELECT TO cerebro_app
  USING ((SELECT authz.has_capability('reports.view'))
         AND list_id IN (SELECT authz.my_item_lists('view', true)));

GRANT SELECT ON app.weekly_reports, app.weekly_report_lists, app.weekly_report_people
  TO cerebro_app;

-- People's names are not readable in general: these are the names of the people
-- on the report's lines this person may read, and nobody else's.
CREATE FUNCTION app.report_names(p_report uuid)
RETURNS TABLE (id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT u.id, u.name
  FROM app.weekly_report_people p
  JOIN app.users u ON u.id = p.user_id
  WHERE p.report_id = p_report
    AND authz.has_capability('reports.view')
    AND p.list_id IN (SELECT authz.my_item_lists('view', true))
$$;

-- ---------------------------------------------------------------------------
-- Made by the routine, never inside a person's request
-- ---------------------------------------------------------------------------

-- Every item not in the trash: whether it is finished now, and whether it was
-- finished between the two moments and has stayed so.
CREATE FUNCTION app.report_items(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (id uuid, list_id uuid, created_at timestamptz, due_date date,
               finished boolean, finished_in_week boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT i.id, i.list_id, i.created_at, i.due_date,
         s.kind IN ('done', 'closed'),
         s.kind IN ('done', 'closed') AND EXISTS (
           SELECT 1 FROM app.item_stage_history h
           WHERE h.item_id = i.id AND h.left_at IS NULL
             AND h.entered_at >= p_from AND h.entered_at < p_to)
  FROM app.items i
  JOIN app.list_stages s ON s.id = i.stage_id
  WHERE i.deleted_at IS NULL
$$;

-- The week that starts on `p_week` (a Monday that has come), or the last full
-- week. A week already written is left as it is. Counts are taken when the
-- report is made: in the first hour of Monday, that is how the week ended.
CREATE FUNCTION app.weekly_report_make(p_week date DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_week   date := coalesce(p_week, date_trunc('week', current_date)::date - 7);
  v_from   timestamptz := v_week::timestamp;
  v_to     timestamptz := (v_week + 7)::timestamp;
  -- Late is due before the week ended, or before today for a week still going on.
  v_late   date := least(v_week + 7, current_date);
  v_report uuid;
BEGIN
  IF authz.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'the weekly report is made on its own, not in a request'
      USING ERRCODE = 'CB001';
  END IF;
  IF extract(isodow FROM v_week) <> 1 OR v_week > current_date THEN
    RAISE EXCEPTION 'a report covers a week from a Monday that has come' USING ERRCODE = '22023';
  END IF;

  -- A year of reports is kept.
  DELETE FROM app.weekly_reports r WHERE r.week_start < current_date - 371;

  INSERT INTO app.weekly_reports (week_start) VALUES (v_week)
  ON CONFLICT (week_start) DO NOTHING
  RETURNING id INTO v_report;
  IF v_report IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO app.weekly_report_lists (report_id, list_id, created, finished, open, overdue)
  SELECT v_report, w.list_id,
         count(*) FILTER (WHERE w.created_at >= v_from AND w.created_at < v_to),
         count(*) FILTER (WHERE w.finished_in_week),
         count(*) FILTER (WHERE NOT w.finished),
         count(*) FILTER (WHERE NOT w.finished AND w.due_date < v_late)
  FROM app.report_items(v_from, v_to) w
  GROUP BY w.list_id
  HAVING count(*) FILTER (WHERE w.created_at >= v_from AND w.created_at < v_to
                            OR w.finished_in_week OR NOT w.finished) > 0;

  INSERT INTO app.weekly_report_people (report_id, list_id, user_id, finished, open, overdue)
  SELECT v_report, w.list_id, ia.user_id,
         count(*) FILTER (WHERE w.finished_in_week),
         count(*) FILTER (WHERE NOT w.finished),
         count(*) FILTER (WHERE NOT w.finished AND w.due_date < v_late)
  FROM app.report_items(v_from, v_to) w
  JOIN app.item_assignees ia ON ia.item_id = w.id
  GROUP BY w.list_id, ia.user_id
  HAVING count(*) FILTER (WHERE w.finished_in_week OR NOT w.finished) > 0;

  RETURN 1;
END
$$;

REVOKE EXECUTE ON FUNCTION app.report_names(uuid), app.weekly_report_make(date),
  app.report_items(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.report_names(uuid), app.weekly_report_make(date) TO cerebro_app;
