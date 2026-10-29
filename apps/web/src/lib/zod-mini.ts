import { en } from "zod/locales";
import { z } from "zod/mini";

// zod/mini loads no locale, and Classic only installs English when it builds a schema.
z.config(en());

export { z };
