# Brand marks

The `.svg` files here are the **source of truth** for every company logo the
app draws. Nothing renders them directly — `scripts/gen-brand-marks.ts`
(`npm run gen:brand-marks`) turns them into path data in
`src/shared/brandMarks.ts`.

They are kept as files rather than pasted into code so the provenance of each
shape is auditable — a path string in a TypeScript file is a shape nobody can
check, and "I downloaded it from somewhere" is not a licence.

## Where they came from

All except `openai.svg` are from [Simple Icons](https://simple-icons.org),
downloaded from `raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/`.
Simple Icons publishes the SVG files under **CC0 1.0** (public domain).

`openai.svg` came from the [Iconify](https://iconify.design) mirror of an
earlier Simple Icons release — see the warning below.

## CC0 covers the drawing, not the trademark

CC0 releases Simple Icons' *rendering* of a logo. It does not, and cannot, grant
any right to **use** the mark: those belong to the companies, and trademark law
is separate from copyright.

The app shows these marks to identify services an operator is **genuinely
connected to** — the same nominative use that lets any app draw a "Sign in
with…" button. That is the whole basis, and it holds only while all of this
stays true:

- **Never alter a mark.** No recolouring the shape to imitate a brand, no adding
  to it, no stretching it. (Tinting to `currentColor` for legibility in a dark
  theme is fine and is not an alteration of the mark's form.)
- **Never imply endorsement, partnership or certification.** None of these
  companies has endorsed this project.
- **Never use one as the app's own identity** — not as an app icon, a favicon, or
  anything a person could mistake for the project's own mark. The project's name says
  which broker it works with ("Robinhood Trading Agents"); it never uses Robinhood's
  logo, colours or wordmark as its own, and it says it is not affiliated wherever the
  name appears in documentation.
- **Only draw a mark next to the thing it actually is.** A Robinhood logo belongs
  on the Robinhood connection, nowhere else.

## ⚠️ OpenAI is the exception, and is the one to watch

1. **It is no longer in Simple Icons.** It was there and was removed. Treat the
   removal as meaningful rather than incidental.
2. **OpenAI enforces its marks actively**, including the "GPT" name, and its brand
   guidelines require third parties not to suggest a relationship that does not
   exist.
3. **The ChatGPT integration is not an API integration.** It runs on the
   operator's own subscription through the Codex OAuth flow — an unofficial
   surface. The "Powered by OpenAI" badge their guidelines offer to API
   customers therefore does not apply.

The mark is drawn in one component (`BrandMark`) from one data file, so removing
it is a one-line change if that is ever the right call.

## Adding one

Drop the SVG here (single path, `viewBox="0 0 24 24"`), add its title and hex to
the tables in `scripts/gen-brand-marks.ts`, and run `npm run gen:brand-marks`.
The script refuses multi-path or wrongly-sized marks rather than emitting a
broken shape.
