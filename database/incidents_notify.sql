CREATE OR REPLACE FUNCTION notify_incidents_changed()
RETURNS trigger AS $$
DECLARE
  changed_id text;
BEGIN
  changed_id := COALESCE(NEW.id, OLD.id);

  PERFORM pg_notify(
    'incidents_changed',
    json_build_object(
      'operation', TG_OP,
      'id', changed_id,
      'table', TG_TABLE_NAME
    )::text
  );

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS incidents_changed_notify ON incidents;

CREATE TRIGGER incidents_changed_notify
AFTER INSERT OR UPDATE OR DELETE ON incidents
FOR EACH ROW
EXECUTE FUNCTION notify_incidents_changed();
