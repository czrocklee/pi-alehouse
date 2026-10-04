# README panel images

Each image labels its provenance; none is a model recommendation or comparative benchmark.

- `routing-panel.svg` is a **historical real terminal capture** of the author's three-slot setup, before five-slot routing and delegation controls. Its original panel contents are retained, not presented as the current UI.
- `effort-panel.svg` is a **controlled UI render with example models**, using the current five-slot `PresetPicker` and `harness/test/support/effort-illustration.mjs`. It is not a live-provider capture, real workload, or host-validation evidence.
- The remaining panels are reviewed real working-session captures, using the author's actual settings and observed activity; they illustrate that personal setup, not built-in defaults.

Only the framed panels were exported. The Agent image removes the values of `run` and `cwd` before SVG serialization and labels those omissions. No background conversation, terminal footer, raw capture, credential file or full personal configuration is included.

## Updating an image

Keep terminal captures and color palettes outside the repository. Review the visible panel before converting it; a panel can contain private paths, conversations or tool output.

```sh
node scripts/render-readme.mjs \
  --screen /path/to/private-local-capture.ansi \
  --colors /path/to/local-kitty-colors.txt \
  --title 'Delegation' \
  --output routing-panel.svg
```

For Agent summaries, additionally use:

```sh
--redact-field run --redact-field cwd \
--caption 'Actual session; identifiers and private path hidden'
```

For a controlled UI illustration, render only synthetic inputs through the
current component after building. Keep its ANSI rows and complete palette
outside the repository, and supply an explicit title/alt description and
`--caption 'Controlled UI render · example models'`; never accept the
converter's default real-capture caption for that input. Preserve and label
historical captures rather than editing their old controls to resemble a new
real session. `test/render-readme.test.mjs` checks the effort illustration
against its controlled renderer and verifies the provenance labels.

The converter requires one complete panel rectangle, strips terminal hyperlinks and excludes surrounding text. Requested redactions must find exactly one matching field. These checks are not a general-purpose secret detector: inspect both the rendered image and its underlying SVG text before publishing. Never commit the raw input files.
