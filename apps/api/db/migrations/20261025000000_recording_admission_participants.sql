-- +goose Up
-- Replacing this CHECK only loosens it; the previous API remains compatible.
ALTER TABLE recording_capacity DROP CONSTRAINT recording_capacity_reserved_participants_check1;
ALTER TABLE recording_capacity ADD CONSTRAINT recording_capacity_reserved_participants_check1
    CHECK (reserved_participants BETWEEN 0 AND 200);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    LOCK TABLE recording_capacity IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM recording_capacity WHERE reserved_participants > 100) THEN
        RAISE EXCEPTION 'Cannot restore participant cap of 100: recording_capacity has reserved_participants above 100; drain reservations first';
    END IF;
    ALTER TABLE recording_capacity DROP CONSTRAINT recording_capacity_reserved_participants_check1;
    ALTER TABLE recording_capacity ADD CONSTRAINT recording_capacity_reserved_participants_check1
        CHECK (reserved_participants BETWEEN 0 AND 100);
END $$;
-- +goose StatementEnd
