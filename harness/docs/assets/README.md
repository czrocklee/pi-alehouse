# README panel images

These images come from a real working terminal session, using the author's actual model presets, effort settings and observed activity. They are not mockups or synthetic workloads. They illustrate one personal setup, not built-in models or comparative benchmarks.

Only the framed panels were exported. The Agent image removes the values of `run` and `cwd` before SVG serialization and labels those omissions. No background conversation, terminal footer, raw capture, credential file or full personal configuration is included.

## Updating an image

Keep terminal captures and color palettes outside the repository. Review the visible panel before converting it; a panel can contain private paths, conversations or tool output.

```sh
node scripts/render-readme.mjs \
  --screen /path/to/private-local-capture.ansi \
  --colors /path/to/local-kitty-colors.txt \
  --title 'Worker routing' \
  --output routing-panel.svg
```

For Agent summaries, additionally use:

```sh
--redact-field run --redact-field cwd \
--caption 'Actual session; identifiers and private path hidden'
```

The converter requires one complete panel rectangle, strips terminal hyperlinks and excludes surrounding text. Requested redactions must find exactly one matching field. These checks are not a general-purpose secret detector: inspect both the rendered image and its underlying SVG text before publishing. Never commit the raw input files.
