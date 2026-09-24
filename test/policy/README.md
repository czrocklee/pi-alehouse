# Synthetic permission regression fixture

`permissions.json` is used only by the isolated policy test lanes. It is **not** a user configuration or an install/default seed; `resources/permissions.json` is the generic production seed.

The extra Bash reader patterns, exact `git status --short`/`mktemp -d`/`pwd` allowances, and two exact `/proc` metadata reads exist to exercise static-read, path, external-directory, write-ceiling, ask, and deny gates against fabricated files. Do not copy deployment-specific paths or personal command exceptions into this fixture.
