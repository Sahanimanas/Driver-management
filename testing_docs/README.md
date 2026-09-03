# Testing documents — registration data extraction

These are the documents used to test "scan the client registration page to
populate the fields of registration". Drop new ones in here and they become
part of the test run.

```bash
npm run test:extraction                          # every document in this folder
npm run test:extraction -- testing_docs/AJAY.pdf # just one
```

## What is here

| File | What it is | What the extractor should get |
| --- | --- | --- |
| `AJAY.pdf` | A real client page — the GreenLine vendor portal driver list, sent through "Print to PDF". Image only: no text layer, 22 drivers on one page. | 22 driver rows with names and registration numbers, offered as a pick-list |
| `sample-registration-form.txt` | A single-driver registration form as labelled text, the shape a per-driver page takes | 21 fields — name, Aadhaar, licence, bank, UAN, references, referred by |

Each document may have a `<name>.expected.json` beside it. That file holds only
the fields worth asserting on, so a partial fixture is fine — anything absent
from it is reported but not judged. Special keys:

- `docType` — asserts the document was classified correctly
- `rows` — a list of driver names that must appear in the pick-list
- `rowCount` — the exact number of rows expected

## How a document is read

The pipeline picks its route from what the file actually is, not its extension:

1. **PDF with a text layer** — the text is read straight off it. Instant, exact,
   no OCR involved.
2. **PDF without one** — a scan, or a browser page sent through "Print to PDF".
   The embedded page images are pulled out and read by OCR, largest first.
   `AJAY.pdf` is this case.
3. **An image** — read by OCR.
4. **Pasted text** — parsed as-is. This is the fallback that always works.

OCR runs in-process through `tesseract.js`, so no external service is needed.
Point `OCR_API_URL` at a service and that is used first instead, with the local
engine as the fallback.

## What comes back

Every field is tagged with how it was found, and the registration form shows the
tag so the supervisor knows how much to trust it:

- `labelled` — found next to its own label. The most trustworthy.
- `pattern` — recognised by shape alone (a 12-digit number, an IFSC code).
- `derived` — inferred from another field.

**Nothing is saved by scanning.** The result is a draft; the supervisor checks
it, corrects it, and fills in whatever came back blank. That is the scope's
"fields which are blank should be populated manually by supervisor".

## A note on the client page

`AJAY.pdf` is a *list* of drivers, not one driver's form, and the portal
truncates long values with an ellipsis before printing. So:

- Names come back complete for most rows; a row the portal cut off is flagged
  `nameTruncated` and shown as "name cut off" in the pick-list.
- Registration numbers are truncated by the portal itself — the digits shown
  are what was on the page, and are marked as truncated rather than presented
  as complete.

Both are properties of the source document, not of the extractor. The
supervisor picks the driver off the list and checks the value against the
original before saving.

## Adding a document

1. Drop the PDF or image in this folder.
2. Run `npm run test:extraction` and read what came out.
3. If it is worth locking in, write `<name>.expected.json` with the fields that
   must keep working, and it becomes a regression test.

Real driver documents contain personal identity data. Anything committed here
should be a sample or have its identifiers changed.
