-- +goose Up
alter table participant_device_hints
    add column device_kind text check (device_kind in ('iphone', 'ipad', 'android_phone', 'android_tablet', 'android_foldable', 'mac', 'windows', 'linux', 'chromeos'));

-- +goose Down
alter table participant_device_hints drop column device_kind;
