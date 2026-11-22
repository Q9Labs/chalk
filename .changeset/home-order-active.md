---
"@q9labsai/chalk-client": minor
"@q9labsai/chalk-whiteboard": patch
---

Listing Spaces takes `order=created|active`: `created` is newest first as before, and `active` puts the most recently used first. An order other than those two fails with the new `SpaceInvalidOrderError` (`space.invalid_order`). A cursor only continues the order it came from, so a cursor from one order sent with the other is refused with `pagination.invalid_cursor`. On a narrow screen, opening the board's drawing tools with the keyboard now moves focus to the first tool instead of dropping it to the page.
