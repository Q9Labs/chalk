-- name: ScreenAnnotationEnabled :one
select coalesce((select enabled from screen_annotation_settings where singleton), sqlc.arg(default_enabled)::boolean)::boolean;
