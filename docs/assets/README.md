# README panel images

Each image labels its provenance; none is a model recommendation or comparative benchmark.

- `effort-panel.svg` is a **controlled UI render with example models**, using the current five-slot `PresetPicker` and `test/support/effort-illustration.mjs`. It is not a live-provider capture, real workload, or host-validation evidence.
- `stats-panel.svg` is a **reviewed real working-session capture**, using the author's actual settings and observed activity; it illustrates that personal setup, not built-in defaults.

Only the framed panels were exported. No background conversation, terminal footer, raw capture, credential file or full personal configuration is included.

## Updating an image

Keep terminal captures and color palettes outside the repository. Review the visible panel before converting it; a panel can contain private paths, conversations or tool output.

```sh
node scripts/render-readme.mjs \
  --screen /path/to/private-local-capture.ansi \
  --colors /path/to/local-kitty-colors.txt \
  --title 'Stats' \
  --output stats-panel.svg
```

For captures with identifying summary fields, additionally redact them explicitly, for example:

```sh
--redact-field run --redact-field cwd \
--caption 'Actual session; identifiers and private path hidden'
```

For a controlled UI illustration, render only synthetic inputs through the
current component after building. Keep its ANSI rows and complete palette
outside the repository, and supply an explicit title/alt description and
`--caption 'Controlled UI render · example models'`; never accept the
converter's default real-capture caption for that input. Do not edit an old
capture's controls to resemble a new session. `test/extensions/render-readme.test.mjs`
checks the effort illustration against its controlled renderer and verifies
the provenance labels.

The converter requires one complete panel rectangle, strips terminal hyperlinks and excludes surrounding text. Requested redactions must find exactly one matching field. These checks are not a general-purpose secret detector: inspect both the rendered image and its underlying SVG text before publishing. Never commit the raw input files.
