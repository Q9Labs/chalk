-- +goose Up
alter table showcase_dataset_registries
    drop constraint showcase_dataset_registries_state_check,
    add constraint showcase_dataset_registries_state_check
        check (state in ('applying', 'applied', 'removing'));

-- +goose Down
alter table showcase_dataset_registries
    drop constraint showcase_dataset_registries_state_check,
    add constraint showcase_dataset_registries_state_check
        check (state in ('applying', 'applied'));
