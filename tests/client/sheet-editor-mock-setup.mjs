// Registers the resolve hook that redirects all @univerjs/* imports to
// the lightweight stub before the test file (and the UniverEditor component
// it mounts) loads any Univer module.
// Passed via `--import ./tests/client/sheet-editor-mock-setup.mjs`.

import { register } from "node:module";

register("./sheet-editor-mock-loader.mjs", import.meta.url);
